import type { FastifyInstance } from 'fastify';
import type { ProviderUsage } from '@agents-panel/shared';
import type { UsageAccount, UsageService } from './service.js';

/**
 * Usage of the active Claude account. It needs a session but mutates nothing, so no CSRF.
 * `?refresh=1` skips the 60 s cache.
 */
export function registerUsageRoutes(
  app: FastifyInstance,
  deps: { usage: UsageService; activeAccount: () => UsageAccount },
): void {
  app.get<{ Querystring: { refresh?: string } }>(
    '/api/usage',
    async (request): Promise<ProviderUsage> =>
      deps.usage.read(deps.activeAccount(), {
        refresh: request.query.refresh === '1' || request.query.refresh === 'true',
      }),
  );
}
