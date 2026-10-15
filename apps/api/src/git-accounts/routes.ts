import type { FastifyInstance, FastifyReply } from 'fastify';
import type { GitProvider } from '@agents-panel/shared';
import type { ReauthVerifier } from '../auth/reauth.js';
import { AUTH_RATE_LIMIT } from '../auth/routes.js';
import { onlyKeys } from '../http/only-keys.js';
import { idParams } from '../projects/routes.js';
import { GitAccountConflictError, GitAccountNotFoundError } from './repo.js';
import { GitAccountValidationError, type GitAccountService } from './service.js';

const createBody = {
  type: 'object',
  required: ['provider', 'name', 'token'],
  additionalProperties: false,
  properties: {
    provider: { type: 'string', enum: ['github', 'gitlab'] },
    name: { type: 'string', maxLength: 128 },
    host: { type: 'string', maxLength: 300 },
    token: { type: 'string', maxLength: 1024 },
    totp: { type: 'string', maxLength: 32 },
  },
} as const;

const patchBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string', maxLength: 128 },
    token: { type: 'string', maxLength: 1024 },
    totp: { type: 'string', maxLength: 32 },
  },
} as const;

interface CreateBody {
  provider: GitProvider;
  name: string;
  host?: string;
  token: string;
  totp?: string;
}

interface PatchBody {
  name?: string;
  token?: string;
  totp?: string;
}

async function respond(reply: FastifyReply, run: () => Promise<unknown>): Promise<FastifyReply> {
  let body: unknown;
  try {
    body = await run();
  } catch (error) {
    if (error instanceof GitAccountNotFoundError)
      return reply.code(404).send({ error: error.message });
    if (error instanceof GitAccountConflictError)
      return reply.code(409).send({ error: error.message });
    if (error instanceof GitAccountValidationError)
      return reply.code(400).send({ error: error.message });
    throw error;
  }
  return reply.sent ? reply : reply.send(body);
}

/**
 * Git accounts. Tokens go in, never out. Creating an account and replacing a token need a
 * fresh TOTP, checked before anything else so a 401 reveals no validation. Session and CSRF
 * come from the global guard.
 */
export function registerGitAccountRoutes(
  app: FastifyInstance,
  deps: { accounts: GitAccountService; reauth: ReauthVerifier },
): void {
  const { accounts, reauth } = deps;

  app.get('/api/git-accounts', () => accounts.list());

  app.post<{ Body: CreateBody }>(
    '/api/git-accounts',
    {
      config: { rateLimit: AUTH_RATE_LIMIT },
      schema: { body: createBody },
      preValidation: onlyKeys(Object.keys(createBody.properties)),
    },
    (request, reply) =>
      respond(reply, async () => {
        if (!reauth.verify(request, reply, request.body.totp)) return undefined;
        const { provider, name, host, token } = request.body;
        const account = await accounts.create({
          provider,
          name,
          token,
          ...(host === undefined ? {} : { host }),
        });
        void reply.code(201);
        return account;
      }),
  );

  app.patch<{ Params: { id: number }; Body: PatchBody }>(
    '/api/git-accounts/:id',
    {
      config: { rateLimit: AUTH_RATE_LIMIT },
      schema: { params: idParams, body: patchBody },
      preValidation: onlyKeys(Object.keys(patchBody.properties)),
    },
    (request, reply) =>
      respond(reply, async () => {
        const { name, token, totp } = request.body;
        if (token !== undefined && !reauth.verify(request, reply, totp)) return undefined;
        let account = accounts.list().find((a) => a.id === request.params.id);
        if (!account)
          throw new GitAccountNotFoundError(
            `Cuenta de git no encontrada: ${String(request.params.id)}`,
          );
        if (token !== undefined) account = await accounts.replaceToken(account.id, token);
        if (name !== undefined) account = accounts.rename(account.id, name);
        return account;
      }),
  );

  app.delete<{ Params: { id: number } }>(
    '/api/git-accounts/:id',
    { schema: { params: idParams } },
    (request, reply) =>
      respond(reply, () => {
        accounts.remove(request.params.id);
        return Promise.resolve({ ok: true });
      }),
  );
}
