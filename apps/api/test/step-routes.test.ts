import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { StepOutcome, WorktreeTransition } from '@agents-panel/shared';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { ChatEventBus } from '../src/chats/events.js';
import { ChatRepository } from '../src/chats/repo.js';
import type { AnalyzeFinding, KyroScopeState, KyroTaskContext } from '../src/kyro/state.js';
import type { PilotKyro } from '../src/pilot/autopilot.js';
import { buildMergeDevPrompt, buildStepPrompt } from '../src/pilot/prompts.js';
import { AutopilotRunRepository } from '../src/pilot/runs-repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { WorktreeStateRepository } from '../src/worktrees/state-repo.js';
import { FakeRunner } from './fake-runner.js';
import { PASSWORD, makeApp, makeGitRepo, mutatingHeaders } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const task: KyroTaskContext = {
  kind: 'scope',
  name: 'demo',
  nextAction: 'plan_sprint',
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
};

async function boot() {
  const runner = new FakeRunner();
  let release: () => void = () => undefined;
  const findings: AnalyzeFinding[] = [];
  const completed: string[] = [];
  const worktree = makeGitRepo();
  const scopeState: KyroScopeState = {
    kind: 'scope',
    scope: 'demo',
    status: 'active',
    nextAction: 'plan_sprint',
    nextTaskId: null,
    sprint: { current: null, closed: 0, total: 2 },
    tasks: { done: 0, total: 0 },
    openDebt: 0,
    pendingReview: 0,
    blockers: [],
  };
  const pilotKyro = {
    readScope: () => Promise.resolve({ ok: true, state: scopeState }),
    readWork: () => Promise.resolve({ ok: false, error: { kind: 'no_target', message: 'x' } }),
    capabilities: () => Promise.resolve({ ok: true, state: [] }),
    contextPackTask: () => Promise.resolve({ ok: true, state: task }),
    workContextPack: () => Promise.resolve({ ok: true, state: task }),
    analyze: () => Promise.resolve({ ok: true, state: findings }),
    completeScope: () => {
      completed.push('scope demo');
      mkdirSync(join(worktree, '.agents', 'kyro'), { recursive: true });
      writeFileSync(join(worktree, '.agents', 'kyro', 'done.md'), 'done\n');
      return Promise.resolve({ ok: true });
    },
    closeWork: () => Promise.resolve({ ok: true }),
  } as unknown as PilotKyro;
  const made = makeApp({}, undefined, { runner, pilotKyro });
  app = made.app;
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
    repoPath: makeGitRepo(),
    baseBranch: 'main',
  });
  const chats = new ChatRepository(made.db);
  const runs = new AutopilotRunRepository(made.db);
  const states = new WorktreeStateRepository(made.db, chats, new ChatEventBus());
  let count = 0;
  const newChat = (kind: 'scope' | 'work' | 'direct' | 'idea', path = worktree) => {
    count += 1;
    const chat = chats.create({
      projectId: project.id,
      kind,
      slug: `demo-${String(count)}`,
      title: 'demo',
      worktreePath: path,
      branch: 'feature/demo',
      status: 'idle',
    });
    states.transition(chat.id, { state: 'planificando', actor: 'agent' });
    return chat;
  };
  const step = (id: number, body: unknown, h = headers) =>
    made.app.inject({
      method: 'POST',
      url: `/api/chats/${String(id)}/steps`,
      headers: h,
      payload: body as object,
    });
  const timeline = async (id: number) =>
    (await made.app.inject({ url: `/api/chats/${String(id)}/timeline`, headers })).json<
      WorktreeTransition[]
    >();
  const hold = () => {
    runner.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  return {
    ...made,
    runner,
    headers,
    cookie,
    csrfToken,
    runs,
    findings,
    completed,
    worktree,
    project,
    newChat,
    step,
    timeline,
    hold,
    release: () => {
      release();
    },
  };
}

describe('POST /api/chats/:id/steps', () => {
  it('needs a session (401) and CSRF (403)', async () => {
    const s = await boot();
    const chat = s.newChat('scope');
    const noSession = { origin: s.headers['origin'] ?? '' };
    expect((await s.step(chat.id, { step: 'plan' }, noSession)).statusCode).toBe(401);
    const noCsrf = { cookie: s.cookie, origin: s.headers['origin'] ?? '' };
    expect((await s.step(chat.id, { step: 'plan' }, noCsrf)).statusCode).toBe(403);
    expect(s.runner.calls).toHaveLength(0);
  });

  it('S17: with the pilot paused, plan launches the agent with the pilot prompt and the Timeline says user', async () => {
    const s = await boot();
    const chat = s.newChat('scope');
    s.runs.create(chat.id);
    s.runs.pause(chat.id);
    const res = await s.step(chat.id, { step: 'plan' });
    expect(res.statusCode).toBe(200);
    expect(res.json<StepOutcome>()).toMatchObject({ step: 'plan', launched: 'plan' });
    await vi_waitFor(() => s.runner.calls.length === 1);
    const call = s.runner.calls[0];
    expect(call?.prompt).toBe(buildStepPrompt('plan', { task, findings: [] }));
    expect(call?.role).toBe('thinker');
    const entry = (await s.timeline(chat.id)).find((t) => t.reason === 'Paso pedido: plan');
    expect(entry).toMatchObject({ actor: 'user', data: { op: 'step', step: 'plan' } });
  });

  it.each(['execute', 'fix', 'close'] as const)('%s runs as executor', async (step) => {
    const s = await boot();
    const chat = s.newChat('scope');
    expect((await s.step(chat.id, { step })).statusCode).toBe(200);
    await vi_waitFor(() => s.runner.calls.length === 1);
    expect(s.runner.calls[0]?.role).toBe('executor');
    expect(s.runner.calls[0]?.prompt).toBe(buildStepPrompt(step, { task, findings: [] }));
  });

  it('qa launches fix with the blocking findings, or close without them', async () => {
    const s = await boot();
    const chat = s.newChat('scope');
    s.findings.push({
      id: 'F1',
      severity: 'HIGH',
      category: 'c',
      detail: 'roto',
    } as AnalyzeFinding);
    const fix = await s.step(chat.id, { step: 'qa' });
    expect(fix.json<StepOutcome>()).toMatchObject({
      step: 'qa',
      launched: 'fix',
      findings: ['HIGH F1 (c): roto'],
    });
    await vi_waitFor(() => s.runner.calls.length === 1);
    expect(s.runner.calls[0]?.prompt).toContain('roto');

    const other = await boot();
    const chat2 = other.newChat('scope');
    const close = await other.step(chat2.id, { step: 'qa' });
    expect(close.json<StepOutcome>()).toMatchObject({ step: 'qa', launched: 'close' });
  });

  it.each(['active', 'queued', 'waiting_quota'] as const)(
    'answers 409 with the pilot %s and launches nothing',
    async (status) => {
      const s = await boot();
      const chat = s.newChat('scope');
      s.runs.create(chat.id);
      if (status === 'queued') s.runs.queue(chat.id);
      if (status === 'waiting_quota') s.runs.waitForQuota(chat.id, Date.now() + 1000);
      const res = await s.step(chat.id, { step: 'plan' });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toContain(status);
      expect(s.runner.calls).toHaveLength(0);
    },
  );

  it('answers 409 while the agent runs', async () => {
    const s = await boot();
    const chat = s.newChat('scope');
    s.hold();
    expect((await s.step(chat.id, { step: 'plan' })).statusCode).toBe(200);
    const again = await s.step(chat.id, { step: 'execute' });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: string }>().error).toContain('corriendo');
    s.release();
  });

  it('404 without worktree, 409 for direct and idea chats, 400 for an unknown step', async () => {
    const s = await boot();
    expect((await s.step(9999, { step: 'plan' })).statusCode).toBe(404);
    for (const kind of ['direct', 'idea'] as const) {
      const chat = s.newChat(kind);
      expect((await s.step(chat.id, { step: 'plan' })).statusCode, kind).toBe(409);
    }
    const chat = s.newChat('scope');
    expect((await s.step(chat.id, { step: 'nope' })).statusCode).toBe(400);
    expect((await s.step(chat.id, { step: 'plan', extra: 1 })).statusCode).toBe(400);
    expect(s.runner.calls).toHaveLength(0);
  });

  it('S11: merge_dev answers 409 without the skill and launches the pilot prompt with it', async () => {
    const s = await boot();
    const chat = s.newChat('scope');
    const without = await s.step(chat.id, { step: 'merge_dev' });
    expect(without.statusCode).toBe(409);
    expect(s.runner.calls).toHaveLength(0);

    const dir = join(s.worktree, '.claude', 'skills', 'merge-dev');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# merge-dev\n');
    const res = await s.step(chat.id, { step: 'merge_dev' });
    expect(res.statusCode).toBe(200);
    await vi_waitFor(() => s.runner.calls.length === 1);
    expect(s.runner.calls[0]?.prompt).toBe(
      buildMergeDevPrompt({ worktree: s.worktree, base: s.project.baseBranch, name: 'demo' }),
    );
    expect(s.runner.calls[0]?.role).toBe('executor');
  });

  it('complete runs the Kyro verb and commits .agents/kyro with actor user', async () => {
    const s = await boot();
    const chat = s.newChat('scope');
    const res = await s.step(chat.id, { step: 'complete' });
    expect(res.statusCode).toBe(200);
    expect(res.json<StepOutcome>()).toMatchObject({
      step: 'complete',
      launched: null,
      output: 'chore(kyro): completar scope demo',
    });
    expect(s.completed).toEqual(['scope demo']);
    const entries = await s.timeline(chat.id);
    expect(
      entries.find((t) => (t.data as { op?: string } | null)?.op === 'commit_kyro'),
    ).toMatchObject({ actor: 'user' });
    expect(entries.find((t) => t.reason === 'Paso pedido: complete')).toMatchObject({
      actor: 'user',
    });
    expect(s.runner.calls).toHaveLength(0);
  });
});

/** Waits until `check` holds: the turn starts in the background after the response. */
async function vi_waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timeout');
}
