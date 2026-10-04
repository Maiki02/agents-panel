import type { FastifyInstance } from 'fastify';
import { onlyKeys } from '../http/only-keys.js';
import { ChatError, type ChatService } from './service.js';
import type { ChatRepository } from './repo.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const createBody = {
  type: 'object',
  required: ['projectId', 'kind', 'slug', 'prompt'],
  additionalProperties: false,
  properties: {
    projectId: { type: 'integer', minimum: 1 },
    kind: { enum: ['scope', 'work'] },
    slug: { type: 'string', minLength: 1, maxLength: 50 },
    prompt: { type: 'string', minLength: 1, maxLength: 20000 },
  },
} as const;

const messageBody = {
  type: 'object',
  required: ['text'],
  additionalProperties: false,
  properties: { text: { type: 'string', minLength: 1, maxLength: 20000 } },
} as const;

export function registerChatRoutes(
  app: FastifyInstance,
  deps: { chats: ChatRepository; service: ChatService },
): void {
  const { chats, service } = deps;

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ChatError) {
      return reply.code(error.status).send({ error: error.message });
    }
    return reply.send(error);
  });

  app.post<{ Body: { projectId: number; kind: 'scope' | 'work'; slug: string; prompt: string } }>(
    '/api/chats',
    // Unknown fields are refused, not silently dropped by ajv.
    { schema: { body: createBody }, preValidation: onlyKeys(Object.keys(createBody.properties)) },
    async (request, reply) => {
      const chat = await service.create(request.body);
      return reply.code(201).send(chat);
    },
  );

  app.get('/api/chats', () => chats.list());

  app.get<{ Params: { id: number } }>(
    '/api/chats/:id',
    { schema: { params: idParams } },
    (request) => service.requireChat(request.params.id),
  );

  app.get<{ Params: { id: number }; Querystring: { afterSeq?: number } }>(
    '/api/chats/:id/events',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          properties: { afterSeq: { type: 'integer', minimum: 0 } },
        },
      },
    },
    (request) => {
      service.requireChat(request.params.id);
      return chats.eventsAfter(request.params.id, request.query.afterSeq ?? 0);
    },
  );

  app.post<{ Params: { id: number }; Body: { text: string } }>(
    '/api/chats/:id/messages',
    {
      schema: { params: idParams, body: messageBody },
      preValidation: onlyKeys(Object.keys(messageBody.properties)),
    },
    (request, reply) => {
      service.sendMessage(request.params.id, request.body.text);
      return reply.code(202).send({ ok: true });
    },
  );

  app.post<{ Params: { id: number } }>(
    '/api/chats/:id/cancel',
    { schema: { params: idParams } },
    (request) => {
      service.cancel(request.params.id);
      return { ok: true };
    },
  );
}
