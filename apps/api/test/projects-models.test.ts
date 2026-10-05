import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Chat, ModelSelection } from '@agents-panel/shared';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { PASSWORD, makeApp, makeKyroRepo, mutatingHeaders } from './helpers.js';
import { FakeRunner } from './fake-runner.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
});

async function boot() {
  const made = makeApp({}, undefined, { runner: new FakeRunner() });
  app = made.app;
  await made.app.ready();
  const user = await new UserRepository(made.db).create('alice', PASSWORD);
  const { token, csrfToken } = new SessionService(made.db, {
    idleTtlSeconds: 1800,
    absoluteTtlSeconds: 43200,
  }).create(user.id);
  const headers = mutatingHeaders(`${SESSION_COOKIE}=${token}`, csrfToken);
  const project = await new ProjectRepository(made.db).add({
    name: 'demo',
    repoPath: makeKyroRepo(),
    baseBranch: 'main',
  });
  const url = `/api/projects/${String(project.id)}/models`;
  return {
    ...made,
    project,
    url,
    headers,
    get: () => made.app.inject({ url, headers }),
    put: (payload: object) => made.app.inject({ method: 'PUT', url, headers, payload }),
    createChat: (slug: string, extra: object = {}) =>
      made.app.inject({
        method: 'POST',
        url: '/api/chats',
        headers,
        payload: { projectId: project.id, kind: 'direct', slug, prompt: 'hola', ...extra },
      }),
  };
}

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';

describe('project models', () => {
  it('returns the defaults for a project without configuration', async () => {
    const { get } = await boot();
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ provider: 'claude', thinker: OPUS, executor: SONNET });
  });

  it('saves catalog models and refuses unknown ones without saving anything', async () => {
    const { get, put } = await boot();
    const ok = await put({
      provider: 'claude',
      thinker: SONNET,
      executor: 'claude-haiku-4-5-20251001',
    });
    expect(ok.statusCode).toBe(200);
    const saved = { provider: 'claude', thinker: SONNET, executor: 'claude-haiku-4-5-20251001' };
    expect((await get()).json()).toEqual(saved);

    for (const bad of [
      { provider: 'claude', thinker: OPUS, executor: 'gpt-9' },
      { provider: 'claude', thinker: 'nope', executor: SONNET },
      { provider: 'openai', thinker: OPUS, executor: SONNET },
    ]) {
      expect((await put(bad)).statusCode).toBe(400);
    }
    expect((await get()).json()).toEqual(saved);
    expect(
      (await put({ provider: 'claude', thinker: OPUS, executor: SONNET, extra: 1 })).statusCode,
    ).toBe(400);
  });

  it('answers 404 for an unknown project', async () => {
    const { app: a, headers } = await boot();
    expect((await a.inject({ url: '/api/projects/999/models', headers })).statusCode).toBe(404);
  });

  it('resolves chat models as override > project > default and freezes them', async () => {
    const { createChat, put, db } = await boot();
    const first = await createChat('c1');
    expect(first.statusCode).toBe(201);
    expect(first.json<Chat>().models).toEqual<ModelSelection>({
      provider: 'claude',
      thinker: OPUS,
      executor: SONNET,
    });

    await put({ provider: 'claude', thinker: SONNET, executor: SONNET });
    const second = await createChat('c2');
    expect(second.json<Chat>().models.thinker).toBe(SONNET);

    const third = await createChat('c3', { models: { executor: 'claude-fable-5-1' } });
    expect(third.json<Chat>().models).toEqual({
      provider: 'claude',
      thinker: SONNET,
      executor: 'claude-fable-5-1',
    });

    await put({ provider: 'claude', thinker: OPUS, executor: OPUS });
    const rows = db
      .prepare('SELECT slug, thinker_model, executor_model FROM chats ORDER BY id')
      .all();
    expect(rows).toEqual([
      { slug: 'c1', thinker_model: OPUS, executor_model: SONNET },
      { slug: 'c2', thinker_model: SONNET, executor_model: SONNET },
      { slug: 'c3', thinker_model: SONNET, executor_model: 'claude-fable-5-1' },
    ]);
  });

  it('refuses a chat override outside the catalog with 400 and creates nothing', async () => {
    const { createChat, db } = await boot();
    const res = await createChat('bad', { models: { thinker: 'not-a-model' } });
    expect(res.statusCode).toBe(400);
    expect(db.prepare('SELECT count(*) AS n FROM chats').get()).toEqual({ n: 0 });
  });

  it('answers 401 without a session and 403 without CSRF', async () => {
    const { app: a, url, headers } = await boot();
    const origin = { origin: 'http://localhost:4200' };
    expect((await a.inject({ url, headers: origin })).statusCode).toBe(401);
    expect((await a.inject({ method: 'PUT', url, headers: origin, payload: {} })).statusCode).toBe(
      401,
    );
    const noCsrf = { cookie: headers['cookie'] ?? '', ...origin };
    const res = await a.inject({
      method: 'PUT',
      url,
      headers: noCsrf,
      payload: { provider: 'claude', thinker: OPUS, executor: SONNET },
    });
    expect(res.statusCode).toBe(403);
  });
});
