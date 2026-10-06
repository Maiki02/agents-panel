import type { FastifyInstance } from 'fastify';
import type { ReauthVerifier } from '../auth/reauth.js';
import { AUTH_RATE_LIMIT } from '../auth/routes.js';
import { onlyKeys } from '../http/only-keys.js';
import { KyroInitError, type KyroBranchService } from './kyro-branch.js';
import { idParams, respond } from './routes.js';

const initBody = {
  type: 'object',
  additionalProperties: false,
  // Optional so a missing code is a 401 invalid_totp (and counts as a failed attempt), not a 400.
  properties: { code: { type: 'string', maxLength: 32 } },
} as const;

/** `kyro install` rewrites the global runtime, so it asks for a fresh TOTP like a Kyro update. */
export function registerKyroBranchRoutes(
  app: FastifyInstance,
  deps: { service: KyroBranchService; reauth: ReauthVerifier },
): void {
  const { service, reauth } = deps;

  app.post<{ Params: { id: number }; Body: { code?: string } }>(
    '/api/projects/:id/kyro-init',
    {
      config: { rateLimit: AUTH_RATE_LIMIT },
      schema: { params: idParams, body: initBody },
      preValidation: onlyKeys(Object.keys(initBody.properties)),
    },
    async (request, reply) => {
      if (!reauth.verify(request, reply, request.body.code)) return reply;
      try {
        return await respond(reply, () => service.init(request.params.id));
      } catch (error) {
        if (error instanceof KyroInitError) return reply.code(500).send({ error: error.message });
        throw error;
      }
    },
  );

  // Pushes the branch the init left behind. Writes only a branch of the project's own remote, so
  // like the pull it needs a session and CSRF but no code.
  app.post<{ Params: { id: number } }>(
    '/api/projects/:id/kyro-init/push',
    { schema: { params: idParams } },
    async (request, reply) => {
      try {
        return await respond(reply, () => service.push(request.params.id));
      } catch (error) {
        if (error instanceof KyroInitError) return reply.code(500).send({ error: error.message });
        throw error;
      }
    },
  );
}
