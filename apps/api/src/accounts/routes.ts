import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ClaudeAccount, NewClaudeAccount } from '@agents-panel/shared';
import { onlyKeys } from '../http/only-keys.js';
import { AccountError, type AccountService } from './service.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const createBody = {
  type: 'object',
  required: ['name', 'configDir'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    configDir: { type: 'string', minLength: 1, maxLength: 1024 },
  },
} as const;

const renameBody = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: { name: { type: 'string', minLength: 1, maxLength: 80 } },
} as const;

const activeBody = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

async function refuse(reply: FastifyReply, error: unknown): Promise<undefined> {
  if (!(error instanceof AccountError)) throw error;
  await reply.code(error.status).send({ error: error.message });
  return undefined;
}

/**
 * Claude accounts and the active one. Everything needs a session (and CSRF when it writes)
 * through the global guard. The active account is global: it applies to the next turn of any chat.
 */
export function registerAccountRoutes(app: FastifyInstance, accounts: AccountService): void {
  app.get('/api/accounts', (): ClaudeAccount[] => accounts.list());

  app.post<{ Body: NewClaudeAccount }>(
    '/api/accounts',
    { schema: { body: createBody }, preValidation: onlyKeys(Object.keys(createBody.properties)) },
    async (request, reply): Promise<ClaudeAccount | undefined> => {
      try {
        const created = accounts.create(request.body);
        await reply.code(201).send(created);
        return undefined;
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  app.patch<{ Params: { id: number }; Body: { name: string } }>(
    '/api/accounts/:id',
    {
      schema: { params: idParams, body: renameBody },
      preValidation: onlyKeys(Object.keys(renameBody.properties)),
    },
    async (request, reply): Promise<ClaudeAccount | undefined> => {
      try {
        return accounts.rename(request.params.id, request.body.name);
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: number } }>(
    '/api/accounts/:id',
    { schema: { params: idParams } },
    async (request, reply): Promise<undefined> => {
      try {
        accounts.delete(request.params.id);
        await reply.code(204).send();
        return undefined;
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );

  app.put<{ Body: { id: number } }>(
    '/api/accounts/active',
    { schema: { body: activeBody }, preValidation: onlyKeys(Object.keys(activeBody.properties)) },
    async (request, reply): Promise<ClaudeAccount | undefined> => {
      try {
        return accounts.activate(request.body.id);
      } catch (error) {
        return refuse(reply, error);
      }
    },
  );
}
