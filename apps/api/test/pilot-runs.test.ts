import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AutopilotInfo, Chat } from '@agents-panel/shared';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { ChatRepository } from '../src/chats/repo.js';
import { AgentSessionRepository } from '../src/chats/sessions-repo.js';
import { loadConfig } from '../src/config.js';
import { AutopilotRunRepository, AutopilotTransitionError } from '../src/pilot/runs-repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { FakeRunner } from './fake-runner.js';
import { PASSWORD, TEST_ENV, makeApp, makeKyroRepo, mutatingHeaders } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(overrides: Record<string, string> = {}) {
  const made = makeApp(overrides, undefined, { runner: new FakeRunner() });
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
  const chats = new ChatRepository(made.db);
  const runs = new AutopilotRunRepository(made.db);
  const post = (url: string, payload?: object, h = headers) =>
    made.app.inject({ method: 'POST', url, headers: h, ...(payload ? { payload } : {}) });
  const get = (url: string, h: Record<string, string> = headers) =>
    made.app.inject({ url, headers: h });
  const newChat = (slug: string, kind: 'scope' | 'work' | 'direct' = 'scope') =>
    chats.create({
      projectId: project.id,
      kind,
      slug,
      title: slug,
      worktreePath: `/tmp/wt/${slug}`,
      branch: `feature/${slug}`,
      status: 'idle',
    });
  return { ...made, headers, project, chats, runs, post, get, newChat };
}

describe('AutopilotRunRepository', () => {
  async function repo() {
    const { runs, newChat } = await boot();
    return { runs, chat: newChat('a') };
  }

  it('starts active and moves only through allowed transitions', async () => {
    const { runs, chat } = await repo();
    expect(runs.get(chat.id)).toBeUndefined();
    expect(runs.create(chat.id)).toMatchObject({
      status: 'active',
      step: null,
      sessionsInSprint: 0,
      stopReason: null,
    });
    expect(runs.pause(chat.id).status).toBe('paused');
    expect(() => runs.pause(chat.id)).toThrow(AutopilotTransitionError);
    expect(runs.resume(chat.id).status).toBe('active');
    expect(() => runs.resume(chat.id)).toThrow(AutopilotTransitionError);
    expect(runs.turnOff(chat.id).status).toBe('off');
    expect(() => runs.turnOff(chat.id)).toThrow(AutopilotTransitionError);
    expect(() => runs.pause(chat.id)).toThrow(AutopilotTransitionError);
    expect(runs.resume(chat.id).status).toBe('active');
  });

  it('a stop needs a reason, keeps it, and resume clears it with the session count', async () => {
    const { runs, chat } = await repo();
    runs.create(chat.id);
    expect(() => runs.stop(chat.id, '  ')).toThrow(AutopilotTransitionError);
    expect(runs.stop(chat.id, 'sin avance')).toMatchObject({
      status: 'stopped',
      stopReason: 'sin avance',
    });
    expect(() => runs.pause(chat.id)).toThrow(AutopilotTransitionError);
    expect(runs.resume(chat.id)).toMatchObject({ status: 'active', stopReason: null });
  });

  it('finished is final and a missing run is refused', async () => {
    const { runs, chat } = await repo();
    expect(() => runs.pause(chat.id)).toThrow(/no está activado/);
    runs.create(chat.id);
    expect(runs.finish(chat.id).status).toBe('finished');
    expect(() => runs.pause(chat.id)).toThrow(AutopilotTransitionError);
    expect(() => runs.resume(chat.id)).toThrow(AutopilotTransitionError);
    expect(() => runs.turnOff(chat.id)).toThrow(AutopilotTransitionError);
  });

  it('refuses two runs for one chat', async () => {
    const { runs, chat } = await repo();
    runs.create(chat.id);
    expect(() => runs.create(chat.id)).toThrow();
  });
});

describe('agent sessions with step and policy version', () => {
  it('records them and defaults to manual', async () => {
    const { db, newChat } = await boot();
    const chat = newChat('s');
    const sessions = new AgentSessionRepository(db);
    sessions.open(chat.id, 'executor', 'claude', 'm');
    sessions.open(chat.id, 'thinker', 'claude', 'm', 2, { step: 'plan', policyVersion: 1 });
    expect(sessions.listByChat(chat.id).map((s) => [s.step, s.policyVersion, s.sprintN])).toEqual([
      ['manual', null, null],
      ['plan', 1, 2],
    ]);
  });
});

describe('autopilot routes', () => {
  it('creates the active run with autopilot: true for scope and work', async () => {
    const { post, get, project } = await boot();
    for (const kind of ['scope', 'work']) {
      const res = await post('/api/chats', {
        projectId: project.id,
        kind,
        slug: `p-${kind}`,
        prompt: 'x',
        autopilot: true,
      });
      expect(res.statusCode).toBe(201);
      const chat = res.json<Chat>();
      const info = (await get(`/api/chats/${String(chat.id)}/autopilot`)).json<AutopilotInfo>();
      expect(info.run).toMatchObject({ chatId: chat.id, status: 'active' });
    }
  });

  it('does not create a run without autopilot, and answers null', async () => {
    const { post, get, project } = await boot();
    const chat = (
      await post('/api/chats', { projectId: project.id, kind: 'work', slug: 'plain', prompt: 'x' })
    ).json<Chat>();
    expect((await get(`/api/chats/${String(chat.id)}/autopilot`)).json<AutopilotInfo>().run).toBe(
      null,
    );
  });

  it('answers 400 for a direct request with autopilot and creates nothing', async () => {
    const { post, chats, project } = await boot();
    const res = await post('/api/chats', {
      projectId: project.id,
      kind: 'direct',
      slug: 'd',
      prompt: 'x',
      autopilot: true,
    });
    expect(res.statusCode).toBe(400);
    expect(chats.list()).toHaveLength(0);
  });

  it('pause, resume and off change the state and answer 409 when they do not apply', async () => {
    const { post, runs, newChat } = await boot();
    const chat = newChat('s');
    const url = `/api/chats/${String(chat.id)}/autopilot`;
    expect((await post(url, { action: 'pause' })).statusCode).toBe(409);
    runs.create(chat.id);
    const status = async (action: string) => {
      const res = await post(url, { action });
      return [res.statusCode, res.json<AutopilotInfo>().run?.status] as const;
    };
    expect(await status('resume')).toEqual([409, undefined]);
    expect(await status('pause')).toEqual([200, 'paused']);
    expect(await status('pause')).toEqual([409, undefined]);
    expect(await status('resume')).toEqual([200, 'active']);
    expect(await status('off')).toEqual([200, 'off']);
    expect(await status('off')).toEqual([409, undefined]);
    expect((await post(url, { action: 'explode' })).statusCode).toBe(400);
    expect((await post(url, { action: 'pause', extra: 1 })).statusCode).toBe(400);
  });

  it('answers 404 for a direct chat and a missing one', async () => {
    const { get, post, newChat } = await boot();
    const direct = newChat('d', 'direct');
    for (const id of [String(direct.id), '999']) {
      expect((await get(`/api/chats/${id}/autopilot`)).statusCode).toBe(404);
      expect((await post(`/api/chats/${id}/autopilot`, { action: 'pause' })).statusCode).toBe(404);
    }
  });

  it('answers 401 without a session and 403 without CSRF', async () => {
    const { app: a, headers, newChat, runs } = await boot();
    const chat = newChat('s');
    runs.create(chat.id);
    const url = `/api/chats/${String(chat.id)}/autopilot`;
    const origin = { origin: 'http://localhost:4200' };
    expect((await a.inject({ url, headers: origin })).statusCode).toBe(401);
    expect(
      (await a.inject({ method: 'POST', url, headers: origin, payload: { action: 'pause' } }))
        .statusCode,
    ).toBe(401);
    const noCsrf = { cookie: headers['cookie'] ?? '', origin: 'http://localhost:4200' };
    expect(
      (await a.inject({ method: 'POST', url, headers: noCsrf, payload: { action: 'pause' } }))
        .statusCode,
    ).toBe(403);
    expect(runs.get(chat.id)?.status).toBe('active');
  });
});

describe('session cap per sprint', () => {
  it('is 6 by default and comes from PILOT_MAX_SESSIONS_PER_SPRINT', () => {
    expect(loadConfig(TEST_ENV).pilotMaxSessionsPerSprint).toBe(6);
    expect(
      loadConfig({ ...TEST_ENV, PILOT_MAX_SESSIONS_PER_SPRINT: '3' }).pilotMaxSessionsPerSprint,
    ).toBe(3);
    expect(() => loadConfig({ ...TEST_ENV, PILOT_MAX_SESSIONS_PER_SPRINT: '0' })).toThrow();
  });

  it('is shown by the autopilot route', async () => {
    const { get, newChat } = await boot({ PILOT_MAX_SESSIONS_PER_SPRINT: '4' });
    const chat = newChat('s');
    expect(
      (await get(`/api/chats/${String(chat.id)}/autopilot`)).json<AutopilotInfo>()
        .maxSessionsPerSprint,
    ).toBe(4);
  });
});
