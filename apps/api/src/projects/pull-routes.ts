import type { FastifyInstance } from 'fastify';
import { GitCommandError, PullRejectedError } from './git.js';
import { repoResultsOf, type PullService } from './pull.js';
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
        // When the root fails the other repos were still updated: their rows go with the error.
        const repos = repoResultsOf(error);
        const extra = repos === undefined ? {} : { repos };
        if (error instanceof PullRejectedError) {
          return reply.code(409).send({ error: error.message, ...extra });
        }
        if (error instanceof GitCommandError) {
          return reply.code(502).send({ error: error.message, ...extra });
        }
        throw error;
      }
    },
  );
}
