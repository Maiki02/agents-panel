import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { HealthResponse } from '@agents-panel/shared';

export const APP_VERSION = '0.0.0';

export function buildApp(options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(options);

  app.get('/api/health', (): HealthResponse => ({ status: 'ok', version: APP_VERSION }));

  return app;
}
