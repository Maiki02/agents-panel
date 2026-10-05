import type { FastifyInstance } from 'fastify';
import type { ReauthVerifier } from '../auth/reauth.js';
import { AUTH_RATE_LIMIT } from '../auth/routes.js';
import { onlyKeys } from '../http/only-keys.js';
import { DeleteBlockedError, DeletePartialError, type ProjectDeleter } from './delete.js';
import { idParams, respond } from './routes.js';

const deleteBody = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    // Optional so a missing code is a 401 invalid_totp (and counts as a failed attempt), not a 400.
    code: { type: 'string', maxLength: 32 },
  },
} as const;

/** Destructive: fresh TOTP plus the project's name typed by the user. The code is checked first. */
export function registerDeleteRoutes(
  app: FastifyInstance,
  deps: { deleter: ProjectDeleter; reauth: ReauthVerifier },
): void {
  const { deleter, reauth } = deps;

  app.delete<{ Params: { id: number }; Body: { name: string; code?: string } }>(
    '/api/projects/:id',
    {
      config: { rateLimit: AUTH_RATE_LIMIT },
      schema: { params: idParams, body: deleteBody },
      preValidation: onlyKeys(Object.keys(deleteBody.properties)),
    },
    async (request, reply) => {
      if (!reauth.verify(request, reply, request.body.code)) return reply;
      try {
        return await respond(reply, async () => {
          try {
            return await deleter.delete(request.params.id, request.body.name);
          } catch (error) {
            // Before respond() turns it into a bare 409: the web needs the list of reasons.
            if (!(error instanceof DeleteBlockedError)) throw error;
            return reply
              .code(409)
              .send({ error: error.message, blockers: error.blockers, running: error.running });
          }
        });
      } catch (error) {
        if (error instanceof DeletePartialError)
          return reply.code(500).send({ error: error.message });
        throw error;
      }
    },
  );
}
