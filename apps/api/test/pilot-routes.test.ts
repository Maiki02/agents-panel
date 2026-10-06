import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AutopilotInfo, WorktreeStateId, WorktreeTransition } from '@agents-panel/shared';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { ChatEventBus } from '../src/chats/events.js';
import { ChatRepository } from '../src/chats/repo.js';
import type { PilotKyro } from '../src/pilot/autopilot.js';
import { REQUIRED_CAPABILITIES } from '../src/pilot/prompts.js';
import { AutopilotRunRepository } from '../src/pilot/runs-repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { WorktreeStateRepository } from '../src/worktrees/state-repo.js';
import { FakeRunner } from './fake-runner.js';
import { PASSWORD, makeApp, makeKyroRepo, mutatingHeaders } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot() {
  const runner = new FakeRunner();
  // Fake Kyro: the pilot's first read is recorded and never answers, so nothing else runs.
  const reads: string[] = [];
  const never = () => new Promise<never>(() => undefined);
  const pilotKyro: PilotKyro = {
    readScope: (cwd: string) => {
      reads.push(cwd);
      return never();
    },
    readWork: (cwd: string) => {
      reads.push(cwd);
      return never();
    },
    capabilities: () => Promise.resolve({ ok: true, state: [...REQUIRED_CAPABILITIES] }),
    contextPackTask: never,
    workContextPack: never,
    analyze: never,
    completeScope: never,
    closeWork: never,
  } as unknown as PilotKyro;
  const made = makeApp({}, undefined, { runner, pilotKyro });
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
  const states = new WorktreeStateRepository(made.db, chats, new ChatEventBus());
  const on = (id: number, h = headers) =>
    made.app.inject({
      method: 'POST',
      url: `/api/chats/${String(id)}/autopilot`,
      headers: h,
      payload: { action: 'on' },
    });
  const newChat = (slug: string, kind: 'scope' | 'work' | 'direct' | 'idea' = 'scope') =>
    chats.create({
      projectId: project.id,
      kind,
      slug,
      title: slug,
      worktreePath: `/tmp/wt/${slug}`,
      branch: `feature/${slug}`,
      status: 'idle',
    });
  const timeline = async (id: number) =>
    (await made.app.inject({ url: `/api/chats/${String(id)}/timeline`, headers })).json<
      WorktreeTransition[]
    >();
  const seed = (id: number, state: WorktreeStateId) =>
    states.transition(id, { state, actor: 'agent' });
  return { ...made, headers, chats, runs, states, on, newChat, timeline, seed, reads };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("autopilot action 'on'", () => {
  it.each(['scope', 'work'] as const)(
    'creates the run of a %s without pilot and kicks it',
    async (kind) => {
      const { on, newChat, runs, seed, timeline, reads } = await boot();
      const chat = newChat('a', kind);
      seed(chat.id, 'planificando');
      const res = await on(chat.id);
      expect(res.statusCode).toBe(200);
      expect(res.json<AutopilotInfo>().run).toMatchObject({ status: 'active', phase: null });
      expect(runs.get(chat.id)?.status).toBe('active');
      await flush();
      expect(reads).toEqual([chat.worktreePath]);
      const last = (await timeline(chat.id)).at(-1);
      expect(last).toMatchObject({ actor: 'user', reason: 'El usuario encendió el piloto' });
    },
  );

  it('switches a pilot that is off back on', async () => {
    const { on, newChat, runs, reads } = await boot();
    const chat = newChat('a');
    runs.create(chat.id);
    runs.turnOff(chat.id);
    const res = await on(chat.id);
    expect(res.statusCode).toBe(200);
    expect(res.json<AutopilotInfo>().run?.status).toBe('active');
    await flush();
    expect(reads).toHaveLength(1);
  });

  it('answers 409 with a reason and changes nothing for direct, idea, already on and PR ready', async () => {
    const { on, newChat, runs, seed, timeline, reads } = await boot();
    const direct = newChat('d', 'direct');
    const idea = newChat('i', 'idea');
    const running = newChat('r');
    runs.create(running.id);
    const ready = newChat('p');
    runs.create(ready.id);
    runs.setPhase(ready.id, 'merge');
    runs.turnOff(ready.id);
    seed(ready.id, 'pr_lista');
    const before = (await timeline(ready.id)).length;
    for (const chat of [direct, idea, running, ready]) {
      const res = await on(chat.id);
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).not.toBe('');
    }
    expect(runs.get(direct.id)).toBeUndefined();
    expect(runs.get(idea.id)).toBeUndefined();
    expect(runs.get(ready.id)?.status).toBe('off');
    expect(await timeline(ready.id)).toHaveLength(before);
    await flush();
    expect(reads).toEqual([]);
  });

  it('says the work already finished when the pilot is finished, not a generic "already on"', async () => {
    const { on, newChat, runs, reads } = await boot();
    const chat = newChat('f', 'work');
    runs.create(chat.id);
    runs.finish(chat.id);
    const res = await on(chat.id);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toContain('ya terminó');
    expect(res.json<{ error: string }>().error).not.toContain('encendido');
    expect(runs.get(chat.id)?.status).toBe('finished');
    await flush();
    expect(reads).toEqual([]);
  });

  it('answers 401 without a session and 403 without CSRF', async () => {
    const { app: a, headers, on, newChat, runs } = await boot();
    const chat = newChat('s');
    const origin = { origin: 'http://localhost:4200' };
    expect((await on(chat.id, origin as typeof headers)).statusCode).toBe(401);
    const noCsrf = { cookie: headers['cookie'] ?? '', origin: 'http://localhost:4200' };
    expect((await on(chat.id, noCsrf as typeof headers)).statusCode).toBe(403);
    expect(runs.get(chat.id)).toBeUndefined();
    expect(a).toBeDefined();
  });

  it('never changes the permission mode of the chat (R10)', async () => {
    const { on, newChat, chats } = await boot();
    const chat = newChat('s');
    const before = chats.findById(chat.id);
    await on(chat.id);
    const after = chats.findById(chat.id);
    expect({ ...after, updatedAt: 0 }).toEqual({ ...before, updatedAt: 0 });
    expect(JSON.stringify(after)).not.toContain('bypassPermissions');
  });
});
