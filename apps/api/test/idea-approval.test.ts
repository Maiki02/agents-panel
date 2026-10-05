import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AutopilotRun, Chat, WorktreeState, WorktreeTransition } from '@agents-panel/shared';
import type { RunParams } from '../src/agent/runner.js';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import type { KyroReadResult } from '../src/kyro/reader.js';
import type { KyroTaskContext, KyroWorkState } from '../src/kyro/state.js';
import type { PilotKyro } from '../src/pilot/autopilot.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { FakeRunner } from './fake-runner.js';
import { PASSWORD, makeApp, makeKyroRepo, mutatingHeaders } from './helpers.js';

let apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

const PLAN = '.agents/kyro/plan/2026-10-05-idea.md';

/** Kyro reports a work that needs planning, whatever the pilot asks. */
const planTasks: KyroWorkState = {
  kind: 'work',
  work: 'idea-a',
  status: 'draft',
  revision: 1,
  nextAction: 'plan_tasks',
  nextTaskId: null,
  tasks: { done: 0, total: 0 },
  blockedReason: null,
};
const pilotKyro: PilotKyro = {
  readScope: () =>
    Promise.resolve({ ok: false, error: { kind: 'no_target', message: 'sin scope' } }),
  readWork: () => Promise.resolve({ ok: true, state: planTasks }),
  capabilities: () =>
    Promise.resolve({
      ok: true,
      state: ['record-evidence', 'review', 'close-sprint', 'analyze', 'context-pack'],
    }),
  contextPackTask: () => Promise.reject(new Error('not used')),
  workContextPack: (): Promise<KyroReadResult<KyroTaskContext>> =>
    Promise.resolve({
      ok: true,
      state: {
        kind: 'work',
        name: 'idea-a',
        nextAction: 'plan_tasks',
        sprintSlug: null,
        sprintObjective: null,
        taskId: null,
        title: null,
        description: null,
        files: [],
        context: null,
        criteria: [],
        scenarios: [],
        openDebt: 0,
        conventions: [],
      },
    }),
  analyze: () => Promise.resolve({ ok: true, state: [] }),
  completeScope: () => Promise.resolve({ ok: true }),
  closeWork: () => Promise.resolve({ ok: true }),
};

async function boot(opts: { kyroFails?: boolean; writePlan?: boolean } = {}) {
  const runner = new FakeRunner();
  runner.script = (params: RunParams) => {
    if (opts.writePlan !== false && params.prompt.includes('kyro-idea')) {
      const file = join(params.cwd, PLAN);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, '# Idea\n');
    }
    return [
      { type: 'system:init', payload: {}, sessionId: `s${String(runner.calls.length)}` },
      { type: 'result:success', payload: {} },
    ];
  };
  const kyroCalls: { file: string; args: string[]; cwd: string }[] = [];
  const made = makeApp({}, undefined, {
    runner,
    pilotKyro,
    kyroRunner: (file, args, options) => {
      kyroCalls.push({ file, args, cwd: options.cwd });
      return opts.kyroFails ? Promise.reject(new Error('work ya existe')) : Promise.resolve('{}');
    },
  });
  apps.push(made.app);
  await made.app.ready();
  const user = await new UserRepository(made.db).create('alice', PASSWORD);
  const { token, csrfToken } = new SessionService(made.db, {
    idleTtlSeconds: 1800,
    absoluteTtlSeconds: 43200,
  }).create(user.id);
  const cookie = `${SESSION_COOKIE}=${token}`;
  const headers = mutatingHeaders(cookie, csrfToken);
  const project = await new ProjectRepository(made.db).add({
    name: 'demo',
    repoPath: makeKyroRepo(),
    baseBranch: 'main',
  });
  const post = (url: string, payload?: object, h: Record<string, string> = headers) =>
    made.app.inject({ method: 'POST', url, headers: h, ...(payload ? { payload } : {}) });
  const get = (url: string) => made.app.inject({ url, headers });
  const waitFor = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 300; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('condition never met');
  };
  const created = await post('/api/chats', {
    projectId: project.id,
    kind: 'idea',
    slug: 'idea-a',
    prompt: 'Una idea',
  });
  const chat = created.json<Chat>();
  const state = async () =>
    (await get(`/api/chats/${String(chat.id)}/state`)).json<WorktreeState | null>();
  if (opts.writePlan !== false) {
    await waitFor(async () => (await state())?.state === 'esperando_aprobacion_plan');
  } else {
    await waitFor(async () => (await state())?.state === 'madurando_idea');
    await waitFor(() => Promise.resolve(runner.calls.length > 0));
  }
  const act = (payload: object, h?: Record<string, string>) =>
    post(`/api/chats/${String(chat.id)}/idea`, payload, h);
  return {
    ...made,
    runner,
    kyroCalls,
    chat,
    userId: user.id,
    cookie,
    state,
    act,
    get,
    waitFor,
    timeline: async () =>
      (await get(`/api/chats/${String(chat.id)}/timeline`)).json<WorktreeTransition[]>(),
    run: async () =>
      (await get(`/api/chats/${String(chat.id)}/autopilot`)).json<{ run: AutopilotRun | null }>()
        .run,
    kind: async () => (await get(`/api/chats/${String(chat.id)}`)).json<Chat>().kind,
  };
}

describe('approving the plan of an idea', () => {
  it('approve_work runs kyro work create with exact argv, turns the chat into a work and the pilot opens a thinker session', async () => {
    const t = await boot();
    const before = t.runner.calls.length;
    const res = await t.act({ action: 'approve_work' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, kind: 'work' });
    expect(t.kyroCalls).toEqual([
      {
        file: 'kyro',
        args: ['work', 'create', '--id', 'idea-a', '--from', PLAN, '--by', 'alice', '--json'],
        cwd: t.chat.worktreePath,
      },
    ]);
    expect(await t.kind()).toBe('work');
    await t.waitFor(() => Promise.resolve(t.runner.calls.length > before));
    expect(t.runner.calls[before]?.role).toBe('thinker');
    expect((await t.run())?.seedPath).toBeNull();

    const decision = (await t.timeline()).find((x) => x.reason === 'Aprobó el plan como work');
    expect(decision).toMatchObject({
      actor: 'user',
      toState: 'planificando',
      data: { action: 'approve_work', path: PLAN, userId: t.userId, username: 'alice' },
    });
  });

  it('approve_scope turns the chat into a scope with a run that carries the idea document', async () => {
    const t = await boot();
    const res = await t.act({ action: 'approve_scope' });
    expect(res.json()).toEqual({ ok: true, kind: 'scope' });
    expect(t.kyroCalls).toEqual([]);
    expect(await t.kind()).toBe('scope');
    expect((await t.run())?.seedPath).toBe(PLAN);
    expect(
      (await t.timeline()).find((x) => x.reason === 'Aprobó el plan como scope'),
    ).toMatchObject({
      actor: 'user',
      data: { action: 'approve_scope', path: PLAN, userId: t.userId },
    });
  });

  it('keeps the chat as an idea and blocks the work with the error of Kyro when work create fails', async () => {
    const t = await boot({ kyroFails: true });
    const res = await t.act({ action: 'approve_work' });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toContain('work ya existe');
    expect(await t.kind()).toBe('idea');
    expect(t.db.prepare('SELECT count(*) AS n FROM autopilot_runs').get()).toEqual({ n: 0 });
    expect(await t.state()).toMatchObject({ state: 'bloqueado', blockedReason: 'kyro_bloqueado' });
  });

  it('request_changes needs text and sends it to the same session as a thinker turn', async () => {
    const t = await boot();
    expect((await t.act({ action: 'request_changes' })).statusCode).toBe(400);
    expect((await t.act({ action: 'request_changes', text: '   ' })).statusCode).toBe(400);
    expect((await t.state())?.state).toBe('esperando_aprobacion_plan');

    const before = t.runner.calls.length;
    const res = await t.act({ action: 'request_changes', text: 'Falta el alcance' });
    expect(res.statusCode).toBe(200);
    await t.waitFor(() => Promise.resolve(t.runner.calls.length > before));
    expect(t.runner.calls[before]).toMatchObject({
      prompt: 'Falta el alcance',
      role: 'thinker',
      resumeSessionId: 's1',
    });
    expect(await t.kind()).toBe('idea');
    expect((await t.timeline()).find((x) => x.reason === 'Pidió cambios al plan')).toMatchObject({
      actor: 'user',
      toState: 'madurando_idea',
      data: { action: 'request_changes', path: PLAN, userId: t.userId },
    });
  });

  it('answers 409 outside esperando_aprobacion_plan and 400 to an unknown action', async () => {
    const t = await boot({ writePlan: false });
    expect((await t.act({ action: 'approve_work' })).statusCode).toBe(409);
    expect((await t.act({ action: 'approve_scope' })).statusCode).toBe(409);
    expect((await t.act({ action: 'request_changes', text: 'x' })).statusCode).toBe(409);
    expect((await t.act({ action: 'nope' })).statusCode).toBe(400);
    expect(t.kyroCalls).toEqual([]);
    expect(await t.kind()).toBe('idea');
  });

  it('answers 401 without a session and 403 without CSRF', async () => {
    const t = await boot();
    const url = `/api/chats/${String(t.chat.id)}/idea`;
    const noSession = await t.app.inject({
      method: 'POST',
      url,
      headers: { origin: 'http://localhost:4200' },
      payload: { action: 'approve_work' },
    });
    expect(noSession.statusCode).toBe(401);
    const noCsrf = await t.app.inject({
      method: 'POST',
      url,
      headers: { cookie: t.cookie, origin: 'http://localhost:4200' },
      payload: { action: 'approve_work' },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(t.kyroCalls).toEqual([]);
    expect(await t.kind()).toBe('idea');
  });

  it('a second decision after the first answers 409 and does not run kyro twice', async () => {
    const t = await boot();
    expect((await t.act({ action: 'approve_work' })).statusCode).toBe(200);
    expect((await t.act({ action: 'approve_work' })).statusCode).toBe(404); // no longer an idea
    expect(t.kyroCalls).toHaveLength(1);
  });
});
