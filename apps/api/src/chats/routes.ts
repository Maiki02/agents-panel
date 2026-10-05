import type { FastifyInstance } from 'fastify';
import {
  IDEA_ACTIONS,
  type Chat,
  type ChatKind,
  type IdeaAction,
  type IdeaDocument,
} from '@agents-panel/shared';
import { readIdeaDocument, type IdeaScanner } from './idea.js';
import type { IdeaActions } from './idea-actions.js';
import { onlyKeys } from '../http/only-keys.js';
import { ChatError, type ChatService } from './service.js';
import type { ChatRepository } from './repo.js';
import type { WorktreeStateRepository } from '../worktrees/state-repo.js';

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
    kind: { enum: ['scope', 'work', 'direct', 'idea'] },
    slug: { type: 'string', minLength: 1, maxLength: 50 },
    prompt: { type: 'string', minLength: 1, maxLength: 20000 },
    autopilot: { type: 'boolean' },
    models: {
      type: 'object',
      additionalProperties: false,
      properties: {
        thinker: { type: 'string', maxLength: 100 },
        executor: { type: 'string', maxLength: 100 },
      },
    },
  },
} as const;

const ideaActionBody = {
  type: 'object',
  required: ['action'],
  additionalProperties: false,
  properties: {
    action: { enum: IDEA_ACTIONS },
    text: { type: 'string', maxLength: 20000 },
  },
} as const;

const messageBody = {
  type: 'object',
  required: ['text'],
  additionalProperties: false,
  properties: { text: { type: 'string', minLength: 1, maxLength: 20000 } },
} as const;

const answerParams = {
  type: 'object',
  required: ['id', 'qid'],
  properties: { id: { type: 'integer', minimum: 1 }, qid: { type: 'integer', minimum: 1 } },
} as const;

/** One entry per question text: chosen option labels and/or free text (validated against the options). */
const answerBody = {
  type: 'object',
  required: ['answer'],
  additionalProperties: false,
  properties: {
    answer: {
      type: 'object',
      minProperties: 1,
      maxProperties: 4,
      additionalProperties: {
        type: 'object',
        properties: {
          selected: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 500 } },
          text: { type: ['string', 'null'], maxLength: 2000 },
        },
      },
    },
  },
} as const;

export function registerChatRoutes(
  app: FastifyInstance,
  deps: {
    chats: ChatRepository;
    service: ChatService;
    worktreeState: WorktreeStateRepository;
    ideas: IdeaScanner;
    ideaActions: IdeaActions;
  },
): void {
  const { chats, service, worktreeState, ideas, ideaActions } = deps;
  /** The list and the sidebar show the fine state of a work next to the chat. */
  const withState = (chat: Chat): Chat => ({
    ...chat,
    workState: chat.kind === 'direct' ? null : (worktreeState.get(chat.id)?.state ?? null),
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ChatError) {
      return reply.code(error.status).send({ error: error.message });
    }
    return reply.send(error);
  });

  app.post<{
    Body: {
      projectId: number;
      kind: ChatKind;
      slug: string;
      prompt: string;
      models?: { thinker?: string; executor?: string };
      autopilot?: boolean;
    };
  }>(
    '/api/chats',
    // Unknown fields are refused, not silently dropped by ajv.
    { schema: { body: createBody }, preValidation: onlyKeys(Object.keys(createBody.properties)) },
    async (request, reply) => {
      const chat = await service.create(request.body);
      return reply.code(201).send(chat);
    },
  );

  app.get<{ Querystring: { projectId?: number } }>(
    '/api/chats',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { projectId: { type: 'integer', minimum: 1 } },
        },
      },
      // ajv strips unknown query fields silently; refuse them instead.
      preValidation: (request, reply, done) => {
        const extra = Object.keys(request.query).find((key) => key !== 'projectId');
        if (extra !== undefined) {
          void reply.code(400).send({ error: `Unknown field: ${extra}` });
          return;
        }
        done();
      },
    },
    (request) => chats.list(request.query.projectId).map(withState),
  );

  app.get<{ Params: { id: number } }>(
    '/api/chats/:id',
    { schema: { params: idParams } },
    (request) => withState(service.requireChat(request.params.id)),
  );

  /**
   * Fine state of a scope or work: `null` until the first transition. A direct chat has no
   * fine state (only the session status), so it answers 404.
   */
  app.get<{ Params: { id: number } }>(
    '/api/chats/:id/state',
    { schema: { params: idParams } },
    (request) => {
      requireStateful(service, request.params.id);
      return worktreeState.get(request.params.id) ?? null;
    },
  );

  /** The document kyro-idea wrote, with the state of the idea, for the approval screen. */
  app.get<{ Params: { id: number } }>(
    '/api/chats/:id/idea',
    { schema: { params: idParams } },
    async (request): Promise<IdeaDocument> => {
      const chat = service.requireChat(request.params.id);
      if (chat.kind !== 'idea') throw new ChatError('El trabajo no es una idea', 404);
      const documents = await ideas.scan(chat).catch(() => []);
      const path = documents.length === 1 ? (documents[0] ?? null) : null;
      const read = path === null ? null : await readIdeaDocument(chat.worktreePath, path);
      return {
        state: worktreeState.get(chat.id)?.state ?? null,
        path,
        documents,
        content: read?.ok ? read.content : null,
        truncated: read?.ok ? read.truncated : false,
      };
    },
  );

  /** The user's decision about the plan: approve it as a scope or a work, or ask for changes. */
  app.post<{ Params: { id: number }; Body: { action: IdeaAction; text?: string } }>(
    '/api/chats/:id/idea',
    {
      schema: { params: idParams, body: ideaActionBody },
      preValidation: onlyKeys(Object.keys(ideaActionBody.properties)),
    },
    async (request) => {
      // The guard guarantees a session; the decision is always the one of that session's user.
      const userId = request.session?.userId;
      if (userId === undefined) throw new ChatError('Unauthorized', 404);
      return ideaActions.apply(request.params.id, userId, request.body);
    },
  );

  app.get<{ Params: { id: number } }>(
    '/api/chats/:id/timeline',
    { schema: { params: idParams } },
    (request) => {
      requireStateful(service, request.params.id);
      return worktreeState.timeline(request.params.id);
    },
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

  app.get<{ Params: { id: number } }>(
    '/api/chats/:id/questions',
    { schema: { params: idParams } },
    (request) => service.listQuestions(request.params.id),
  );

  app.post<{ Params: { id: number; qid: number }; Body: { answer: unknown } }>(
    '/api/chats/:id/questions/:qid/answer',
    {
      schema: { params: answerParams, body: answerBody },
      preValidation: onlyKeys(Object.keys(answerBody.properties)),
    },
    (request) => {
      // The guard guarantees a session; answered_by is always the user of that session.
      const userId = request.session?.userId;
      if (userId === undefined) throw new ChatError('Unauthorized', 404);
      return service.answerQuestion(
        request.params.id,
        request.params.qid,
        request.body.answer,
        userId,
      );
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

/** 404 for a missing chat and for a direct chat, which has no fine state or Timeline. */
function requireStateful(service: ChatService, chatId: number): void {
  if (service.requireChat(chatId).kind === 'direct') {
    throw new ChatError('Un pedido directo no tiene estado de trabajo', 404);
  }
}
