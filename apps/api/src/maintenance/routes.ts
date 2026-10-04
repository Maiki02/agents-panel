import type { FastifyInstance } from 'fastify';
import type { KyroVersionInfo, MaintenanceRun } from '@agents-panel/shared';
import type { ReauthVerifier } from '../auth/reauth.js';
import { AUTH_RATE_LIMIT } from '../auth/routes.js';
import { onlyKeys } from '../http/only-keys.js';
import type { MaintenanceRunRepository } from './runs.js';
import { UpdateBlockedError, type KyroUpdater } from './updater.js';
import type { KyroVersions } from './versions.js';

const RUNS_LIMIT = 50;

const updateBody = {
  type: 'object',
  additionalProperties: false,
  // Optional so a missing code is a 401 invalid_totp (and counts as a failed attempt), not a 400.
  properties: { code: { type: 'string', maxLength: 32 } },
} as const;

const runsQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { kind: { type: 'string', enum: ['kyro-update'] } },
} as const;

export interface MaintenanceRouteDeps {
  versions: Pick<KyroVersions, 'installed' | 'latest'>;
  updater: Pick<KyroUpdater, 'start'>;
  runs: MaintenanceRunRepository;
  reauth: ReauthVerifier;
  /** True while a Kyro update holds the maintenance lock. */
  isUpdating: () => boolean;
}

/**
 * Kyro versions and updates. The update needs a fresh TOTP (checked first, so a 401 reveals
 * nothing else) and is refused while sessions run or another update is in progress.
 */
export function registerMaintenanceRoutes(app: FastifyInstance, deps: MaintenanceRouteDeps): void {
  const { versions, updater, runs, reauth, isUpdating } = deps;

  app.get(
    '/api/versions',
    async (): Promise<{ kyro: KyroVersionInfo & { updateRunning: boolean } }> => {
      const [installed, latest] = await Promise.all([versions.installed(), versions.latest()]);
      return { kyro: { installed, latest, updateRunning: isUpdating() } };
    },
  );

  app.post<{ Body: { code?: string } }>(
    '/api/versions/kyro/update',
    {
      config: { rateLimit: AUTH_RATE_LIMIT },
      schema: { body: updateBody },
      preValidation: onlyKeys(Object.keys(updateBody.properties)),
    },
    async (request, reply) => {
      if (!reauth.verify(request, reply, request.body.code)) return reply;
      try {
        const runId = await updater.start();
        return await reply.code(202).send({ runId });
      } catch (error) {
        if (error instanceof UpdateBlockedError) {
          return reply.code(error.status).send({ error: error.message, running: error.running });
        }
        throw error;
      }
    },
  );

  app.get('/api/maintenance-runs', { schema: { querystring: runsQuery } }, (): MaintenanceRun[] =>
    runs.list(RUNS_LIMIT),
  );
}
