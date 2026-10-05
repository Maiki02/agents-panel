import type { FastifyInstance } from 'fastify';
import { GitCommandError, PullRejectedError } from './git.js';
import type { PullService } from './pull.js';
import { idParams, respond } from './routes.js';

/** Fast-forward only, so it needs the session and CSRF but no TOTP: it cannot lose work. */
export function registerPullRoutes(app: FastifyInstance, deps: { service: PullService }): void {
  app.post<{ Params: { id: number } }>(
    '/api/projects/:id/pull',
    { schema: { params: idParams } },
    async (request, reply) => {
      try {
        return await respond(reply, () => deps.service.pullBase(request.params.id));
      } catch (error) {
        if (error instanceof PullRejectedError) {
          return reply.code(409).send({ error: error.message });
        }
        if (error instanceof GitCommandError) return reply.code(502).send({ error: error.message });
        throw error;
      }
    },
  );
}
