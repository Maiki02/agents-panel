import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Chat, ChatEvent, PendingQuestion } from '@agents-panel/shared';
import { AgentManager } from '../src/agent/manager.js';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { ChatEventBus } from '../src/chats/events.js';
import { QuestionRepository } from '../src/chats/questions-repo.js';
import { ChatRepository } from '../src/chats/repo.js';
import { openDatabase } from '../src/db/index.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { FakeRunner } from './fake-runner.js';
import { ORIGIN, PASSWORD, makeApp, makeKyroRepo, mutatingHeaders } from './helpers.js';

let apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

const ASK = {
  questions: [
    {
      question: '¿Cuál es tu color favorito?',
      header: 'Color',
      options: [
        { label: 'Rojo', description: 'Rojo' },
        { label: 'Azul', description: 'Azul' },
      ],
      multiSelect: false,
    },
  ],
};
const Q = ASK.questions[0]?.question ?? '';

async function boot(db = openDatabase(':memory:')) {
  const runner = new FakeRunner();
  const decisions: unknown[] = [];
  runner.script = async (params) => {
    decisions.push(await params.canUseTool('AskUserQuestion', ASK, { toolUseId: 'toolu_1' }));
    return [{ type: 'result:success', payload: {} }];
  };
  const bus = new ChatEventBus();
  const manager = new AgentManager(
    new ChatRepository(db),
    runner,
    bus,
    undefined,
    new QuestionRepository(db),
  );
  const made = makeApp({}, undefined, { runner, db, bus, manager });
  apps.push(made.app);
  await made.app.ready();
  const users = new UserRepository(made.db);
  const user = users.findByUsername('alice') ?? (await users.create('alice', PASSWORD));
  const sessions = new SessionService(made.db, { idleTtlSeconds: 1800, absoluteTtlSeconds: 43200 });
  const { token, csrfToken } = sessions.create(user.id);
  const headers = mutatingHeaders(`${SESSION_COOKIE}=${token}`, csrfToken);
  const projects = new ProjectRepository(made.db);
  const project =
    projects.list()[0] ??
    (await projects.add({ name: 'demo', repoPath: makeKyroRepo(), baseBranch: 'main' }));
  const post = (url: string, payload?: object) =>
    made.app.inject({ method: 'POST', url, headers, ...(payload ? { payload } : {}) });
  const get = (url: string) => made.app.inject({ url, headers });
  const startChat = async (slug: string) => {
    const created = await post('/api/chats', {
      projectId: project.id,
      kind: 'direct',
      slug,
      prompt: 'hola',
    });
    expect(created.statusCode).toBe(201);
    const chat = created.json<Chat>();
    for (let i = 0; i < 200; i++) {
      const list = (await get(`/api/chats/${String(chat.id)}/questions`)).json<PendingQuestion[]>();
      const [question] = list;
      if (question) return { chat, question };
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('the question never arrived');
  };
  return { ...made, user, runner, decisions, manager, headers, post, get, startChat };
}

const answerUrl = (chatId: number, qid: number) =>
  `/api/chats/${String(chatId)}/questions/${String(qid)}/answer`;

describe('chat question routes', () => {
  it('lists the pending question with its options', async () => {
    const { get, startChat } = await boot();
    const { chat, question } = await startChat('ask');
    expect(question).toMatchObject({ chatId: chat.id, status: 'pending', answer: null });
    expect(question.questions[0]?.options.map((o) => o.label)).toEqual(['Rojo', 'Azul']);
    expect((await get(`/api/chats/${String(chat.id)}`)).json<Chat>().status).toBe('running');
  });

  it('answers with an option: the turn continues with it and answered_by is the session user', async () => {
    const { user, db, decisions, post, get, startChat, manager } = await boot();
    const { chat, question } = await startChat('ask');
    const res = await post(answerUrl(chat.id, question.id), {
      answer: { [Q]: { selected: ['Azul'] } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<PendingQuestion>()).toMatchObject({
      status: 'answered',
      answeredBy: user.id,
      answer: { [Q]: { selected: ['Azul'], text: null } },
    });
    await manager.waitForIdle(chat.id);
    expect(decisions).toEqual([
      { behavior: 'allow', updatedInput: { ...ASK, answers: { [Q]: 'Azul' } } },
    ]);
    const events = (await get(`/api/chats/${String(chat.id)}/events`)).json<ChatEvent[]>();
    expect(events.map((e) => e.type)).toContain('question_answered');
    expect(db.prepare('SELECT answered_by FROM pending_questions').get()).toEqual({
      answered_by: user.id,
    });
  });

  it('answers with free text', async () => {
    const { decisions, post, startChat, manager } = await boot();
    const { chat, question } = await startChat('ask');
    const res = await post(answerUrl(chat.id, question.id), { answer: { [Q]: { text: 'Verde' } } });
    expect(res.statusCode).toBe(200);
    await manager.waitForIdle(chat.id);
    expect(decisions).toMatchObject([{ updatedInput: { answers: { [Q]: 'Verde' } } }]);
  });

  it('answers 409 the second time and keeps the first answer', async () => {
    const { post, get, startChat, manager } = await boot();
    const { chat, question } = await startChat('ask');
    await post(answerUrl(chat.id, question.id), { answer: { [Q]: { selected: ['Rojo'] } } });
    const again = await post(answerUrl(chat.id, question.id), {
      answer: { [Q]: { selected: ['Azul'] } },
    });
    expect(again.statusCode).toBe(409);
    await manager.waitForIdle(chat.id);
    const [stored] = (await get(`/api/chats/${String(chat.id)}/questions`)).json<
      PendingQuestion[]
    >();
    expect(stored?.answer).toEqual({ [Q]: { selected: ['Rojo'], text: null } });
  });

  it('answers 404 for a question of another chat or one that does not exist', async () => {
    const { post, startChat, manager } = await boot();
    const first = await startChat('one');
    const second = await startChat('two');
    expect(
      (await post(answerUrl(second.chat.id, first.question.id), { answer: { [Q]: { text: 'x' } } }))
        .statusCode,
    ).toBe(404);
    expect(
      (await post(answerUrl(first.chat.id, 9999), { answer: { [Q]: { text: 'x' } } })).statusCode,
    ).toBe(404);
    expect(
      (await post(answerUrl(9999, first.question.id), { answer: { [Q]: { text: 'x' } } }))
        .statusCode,
    ).toBe(404);
    manager.cancel(first.chat.id);
    manager.cancel(second.chat.id);
    await manager.waitForIdle(first.chat.id);
    await manager.waitForIdle(second.chat.id);
  });

  it.each([
    ['an option that does not exist', { answer: { [Q]: { selected: ['Verde'] } } }],
    ['an empty answer', { answer: { [Q]: { selected: [], text: '  ' } } }],
    ['a missing question', { answer: { otra: { text: 'x' } } }],
    ['an unknown field', { answer: { [Q]: { text: 'x' } }, extra: 1 }],
    ['no answer field', {}],
    ['a text that is too long', { answer: { [Q]: { text: 'x'.repeat(2001) } } }],
  ])('answers 400 to %s and leaves the question pending', async (_name, body) => {
    const { post, get, startChat, manager } = await boot();
    const { chat, question } = await startChat('ask');
    const res = await post(answerUrl(chat.id, question.id), body);
    expect(res.statusCode).toBe(400);
    const [stored] = (await get(`/api/chats/${String(chat.id)}/questions`)).json<
      PendingQuestion[]
    >();
    expect(stored?.status).toBe('pending');
    manager.cancel(chat.id);
    await manager.waitForIdle(chat.id);
  });

  it('answers 401 without a session and 403 to a POST without CSRF', async () => {
    const { app, headers, startChat, manager } = await boot();
    const { chat, question } = await startChat('ask');
    const url = answerUrl(chat.id, question.id);
    const body = { answer: { [Q]: { selected: ['Rojo'] } } };
    expect(
      (
        await app.inject({
          url: `/api/chats/${String(chat.id)}/questions`,
          headers: { origin: ORIGIN },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url, headers: { origin: ORIGIN }, payload: body }))
        .statusCode,
    ).toBe(401);
    const withoutCsrf = { cookie: headers['cookie'] ?? '', origin: ORIGIN };
    expect(
      (await app.inject({ method: 'POST', url, headers: withoutCsrf, payload: body })).statusCode,
    ).toBe(403);
    manager.cancel(chat.id);
    await manager.waitForIdle(chat.id);
  });

  it('after a restart the pending question is cancelled and the chat is interrupted', async () => {
    const db = openDatabase(':memory:');
    const first = await boot(db);
    const { chat, question } = await first.startChat('ask');
    // Simulate the crash: the in-memory turn is gone, the rows stay as they were.
    first.manager.cancel(chat.id);
    await first.manager.waitForIdle(chat.id);
    db.prepare("UPDATE pending_questions SET status = 'pending' WHERE id = ?").run(question.id);
    db.prepare("UPDATE chats SET status = 'running' WHERE id = ?").run(chat.id);

    const second = await boot(db);
    const url = `/api/chats/${String(chat.id)}`;
    expect((await second.get(url)).json<Chat>().status).toBe('interrupted');
    const [stored] = (await second.get(`${url}/questions`)).json<PendingQuestion[]>();
    expect(stored).toMatchObject({ id: question.id, status: 'cancelled' });
    const late = await second.post(answerUrl(chat.id, question.id), {
      answer: { [Q]: { selected: ['Rojo'] } },
    });
    expect(late.statusCode).toBe(409);
  });
});
