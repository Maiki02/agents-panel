import type { FastifyInstance } from 'fastify';
import type { DiskRefreshResponse, DiskUsage, MemoryUsage } from '@agents-panel/shared';
import type { DiskMonitor } from './disk.js';

/**
 * Disk use. Behind the session guard like every route; the POST goes through the CSRF check.
 * Only project names and numbers leave the API, never a path.
 */
export function registerCapacityRoutes(
  app: FastifyInstance,
  deps: { disk: Pick<DiskMonitor, 'get' | 'refresh'>; memory: () => MemoryUsage },
): void {
  // RAM is read from /proc on every request (no cache).
  app.get('/api/capacity/memory', (): MemoryUsage => deps.memory());

  app.get('/api/capacity/disk', (): DiskUsage => deps.disk.get());

  app.post('/api/capacity/disk/refresh', async (_request, reply): Promise<DiskRefreshResponse> => {
    const started = deps.disk.refresh();
    return reply.code(started ? 202 : 200).send({ started, measuring: true });
  });
}
