import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ClaudeAccount } from '@agents-panel/shared';
import { AUTH_RATE_LIMIT } from '../auth/routes.js';
import type { ReauthVerifier } from '../auth/reauth.js';
import { onlyKeys } from '../http/only-keys.js';
import type { ReloginService } from './relogin.js';
import { AccountError } from './service.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const startBody = {
  type: 'object',
  required: ['totp'],
  additionalProperties: false,
  properties: { totp: { type: 'string', minLength: 1, maxLength: 16 } },
} as const;

const codeBody = {
  type: 'object',
  required: ['code'],
  additionalProperties: false,
  properties: { code: { type: 'string', minLength: 1, maxLength: 1024 } },
} as const;

async function refuse(reply: FastifyReply, error: unknown): Promise<undefined> {
  if (!(error instanceof AccountError)) throw error;
  await reply.code(error.status).send({ error: error.message });
  return undefined;
}

/**
 * Re-login of a Claude account. Session and CSRF come from the global guard. Starting the login
 * needs a fresh TOTP (it launches a process on the VM); typing the code of the browser into that
 * process does not, because a TOTP code works only once and the flow is already tied to a verified
 * start. Neither the link nor the code is logged.
 */
export function registerReloginRoutes(
  app: FastifyInstance,
  deps: { relogin: ReloginService; reauth: ReauthVerifier },
): void {
  const { relogin, reauth } = deps;

  app.post<{ Params: { id: number }; Body: { totp: string } }>(
    '/api/accounts/:id/relogin',
    {
      config: { rateLimit: AUTH_RATE_LIMIT },
      schema: { params: idParams, body: startBody },
      preValidation: onlyKeys(Object.keys(startBody.properties)),
    },
    async (request, reply): Promise<{ url: string } | undefined> => {
      // The TOTP goes first, so a 401 reveals nothing about the account.
      if (!reauth.verify(request, reply, request.body.totp)) return undefined;
      try {
        return await relogin.start(request.params.id);
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  app.post<{ Params: { id: number }; Body: { code: string } }>(
    '/api/accounts/:id/relogin/code',
    {
      config: { rateLimit: AUTH_RATE_LIMIT },
      schema: { params: idParams, body: codeBody },
      preValidation: onlyKeys(Object.keys(codeBody.properties)),
    },
    async (request, reply): Promise<ClaudeAccount | undefined> => {
      try {
        return await relogin.submitCode(request.params.id, request.body.code);
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: number } }>(
    '/api/accounts/:id/relogin',
    { schema: { params: idParams } },
    async (request, reply): Promise<undefined> => {
      relogin.cancel(request.params.id);
      await reply.code(204).send();
      return undefined;
    },
  );
}
