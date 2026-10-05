import { fingerprint } from '../src/pilot/decide.js';
import { describe, expect, it } from 'vitest';
import type { AutopilotStep } from '@agents-panel/shared';
import { AgentManager } from '../src/agent/manager.js';
import { buildQueryOptions } from '../src/agent/sdk-runner.js';
import type { AgentEvent, RunParams } from '../src/agent/runner.js';
import { ChatEventBus } from '../src/chats/events.js';
import { QuestionRepository } from '../src/chats/questions-repo.js';
import { ChatRepository } from '../src/chats/repo.js';
import { AgentSessionRepository } from '../src/chats/sessions-repo.js';
import { openDatabase } from '../src/db/index.js';
import type { KyroReadResult } from '../src/kyro/reader.js';
import type { AnalyzeFinding, KyroScopeState, KyroTaskContext } from '../src/kyro/state.js';
import {
  Autopilot,
  QUOTA_RETRY_MS,
  usedSkill,
  hitUsageLimit,
  type PilotKyro,
} from '../src/pilot/autopilot.js';
import { POLICY_VERSION } from '../src/pilot/policy.js';
import { AutopilotRunRepository } from '../src/pilot/runs-repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { WorktreeStateRepository } from '../src/worktrees/state-repo.js';
import { WorktreeStateTracker } from '../src/worktrees/state-tracker.js';
import { FakeRunner } from './fake-runner.js';
import { makeGitRepo } from './helpers.js';

const CAPABILITIES = ['record-evidence', 'review', 'close-sprint', 'analyze', 'context-pack'];

/** A scope of `total` sprints with one task each, moved by what the fake sessions do. */
class FakeKyro implements PilotKyro {
  state: KyroScopeState;
  capabilities_ = [...CAPABILITIES];
  findings: AnalyzeFinding[] = [];
  analyzeCalls = 0;
  /** When true a fix session does not clear the findings (to reach the session cap). */
  keepFindings = false;

  constructor(total = 2) {
    this.state = {
      kind: 'scope',
      scope: 'demo',
      status: 'active',
      nextAction: 'plan_sprint',
      nextTaskId: null,
      sprint: { current: null, closed: 0, total },
      tasks: { done: 0, total: 0 },
      openDebt: 0,
      pendingReview: 0,
      blockers: [],
    };
  }

  readScope(): Promise<KyroReadResult<KyroScopeState>> {
    return Promise.resolve({ ok: true, state: structuredClone(this.state) });
  }
  readWork(): Promise<never> {
    return Promise.reject(new Error('not a work'));
  }
  capabilities(): Promise<KyroReadResult<string[]>> {
    return Promise.resolve({ ok: true, state: this.capabilities_ });
  }
  contextPackTask(): Promise<KyroReadResult<KyroTaskContext>> {
    return Promise.resolve({
      ok: true,
      state: {
        kind: 'scope',
        name: 'demo',
        nextAction: this.state.nextAction,
        sprintSlug: `s${String(this.state.sprint.current ?? 0)}`,
        sprintObjective: 'obj',
        taskId: this.state.nextTaskId,
        title: 't',
        description: 'd',
        files: [],
        context: null,
        criteria: [],
        scenarios: [],
        openDebt: 0,
        conventions: [],
      },
    });
  }
  workContextPack(): Promise<never> {
    return Promise.reject(new Error('not a work'));
  }
  analyze(): Promise<KyroReadResult<AnalyzeFinding[]>> {
    this.analyzeCalls++;
    return Promise.resolve({ ok: true, state: this.findings });
  }

  /** What a session of each step does to Kyro. */
  apply(step: string): void {
    const s = this.state;
    if (step === 'plan') {
      s.sprint.current = (s.sprint.closed ?? 0) + 1;
      s.nextAction = 'execute_task';
      s.nextTaskId = `T${String(s.sprint.current)}.1`;
      s.tasks.total += 1;
    } else if (step === 'execute') {
      s.nextAction = 'qa_or_close';
      s.nextTaskId = null;
      s.tasks.done += 1;
    } else if (step === 'fix') {
      if (!this.keepFindings) this.findings = [];
      s.tasks.done += 1;
    } else if (step === 'close') {
      const closed = (s.sprint.closed ?? 0) + 1;
      s.sprint.closed = closed;
      s.sprint.current = null;
      s.nextAction = closed < (s.sprint.total ?? 0) ? 'plan_sprint' : 'await_scope_completion';
    }
  }
}

function stepOf(prompt: string): string {
  if (prompt.includes('panel restarted')) return 'execute';
  if (prompt.includes('This is a planning session')) return 'plan';
  if (prompt.includes('Fix the findings')) return 'fix';
  if (prompt.includes('This is a closing session')) return 'close';
  return 'execute';
}

const qaEvent: AgentEvent = {
  type: 'assistant',
  payload: {
    message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'kyro-qa' } }] },
  },
};

async function setup(
  opts: { total?: number; maxConcurrent?: number; maxSessions?: number; skipQa?: boolean } = {},
) {
  const db = openDatabase(':memory:');
  const project = await new ProjectRepository(db).add({
    name: 'demo',
    repoPath: makeGitRepo(),
    baseBranch: 'main',
  });
  const chats = new ChatRepository(db);
  const bus = new ChatEventBus();
  const kyro = new FakeKyro(opts.total);
  const states = new WorktreeStateRepository(db, chats, bus);
  const tracker = new WorktreeStateTracker(states, kyro);
  const questions = new QuestionRepository(db);
  const sessions = new AgentSessionRepository(db);
  const runner = new FakeRunner();
  let n = 0;
  runner.script = (params: RunParams) => {
    const step = stepOf(params.prompt);
    // Only the pilot's prompts move Kyro; a manual message does nothing to it.
    if (params.prompt.includes('Autopilot policy') || params.prompt.includes('panel restarted')) {
      kyro.apply(step);
    }
    n++;
    const events: AgentEvent[] = [
      { type: 'system:init', payload: {}, sessionId: `sess-${String(n)}` },
      { type: 'assistant', payload: { text: 'hecho' } },
    ];
    if (step === 'close' && opts.skipQa !== true) events.push(qaEvent);
    events.push({ type: 'result:success', payload: { result: 'ok' } });
    return events;
  };
  const manager = new AgentManager(
    chats,
    runner,
    bus,
    opts.maxConcurrent ?? 4,
    questions,
    sessions,
    tracker,
  );
  const runs = new AutopilotRunRepository(db);
  const scheduled: { fn: () => void; ms: number }[] = [];
  let clock = 1_000_000;
  const pilot = new Autopilot({
    chats,
    runs,
    manager,
    kyro,
    tracker,
    questions,
    sessions,
    maxSessionsPerSprint: opts.maxSessions ?? 6,
    now: () => clock,
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
  });
  const newChat = (slug: string) =>
    chats.create({
      projectId: project.id,
      kind: 'scope',
      slug,
      title: slug,
      worktreePath: `/tmp/wt/${slug}`,
      branch: `feature/${slug}`,
      status: 'idle',
    });
  const chat = newChat('a');
  tracker.created(chat);
  runs.create(chat.id);
  return {
    db,
    chats,
    kyro,
    states,
    tracker,
    sessions,
    runner,
    manager,
    runs,
    pilot,
    chat,
    newChat,
    scheduled,
    tick: (ms: number) => (clock += ms),
    clock: () => clock,
  };
}

describe('Autopilot over a 2-sprint scope (S7)', () => {
  it('opens a new session per step with the model of its role and stops at await_scope_completion', async () => {
    const t = await setup();
    await t.pilot.drive(t.chat.id);

    expect(t.runner.calls.map((c) => [c.role, c.model])).toEqual([
      ['thinker', 'claude-opus-5-5'],
      ['executor', 'claude-sonnet-5-5'],
      ['executor', 'claude-sonnet-5-5'],
      ['thinker', 'claude-opus-5-5'],
      ['executor', 'claude-sonnet-5-5'],
      ['executor', 'claude-sonnet-5-5'],
    ]);
    // Never resumes the previous SDK session: each step starts a new one.
    expect(t.runner.calls.every((c) => c.resumeSessionId === undefined)).toBe(true);
    expect(t.sessions.listByChat(t.chat.id).map((s) => [s.step, s.policyVersion])).toEqual(
      (['plan', 'execute', 'close', 'plan', 'execute', 'close'] as AutopilotStep[]).map((s) => [
        s,
        POLICY_VERSION,
      ]),
    );
    expect(t.kyro.analyzeCalls).toBe(2);
    expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'stopped' });
    expect(t.states.get(t.chat.id)?.state).toBe('esperando_aprobacion_cierre');
  });

  it('leaves every pilot transition in the Timeline with actor pilot, step, role, model and policy', async () => {
    const t = await setup({ total: 1 });
    await t.pilot.drive(t.chat.id);
    const pilot = t.states.timeline(t.chat.id).filter((x) => x.actor === 'pilot');
    expect(pilot.length).toBeGreaterThan(3);
    const started = pilot.find((x) => x.toState === 'planificando');
    expect(started).toMatchObject({ role: 'thinker', model: 'claude-opus-5-5' });
    expect(started?.data).toMatchObject({ step: 'plan', policyVersion: POLICY_VERSION });
    expect(pilot.every((x) => x.role !== null && x.model !== null)).toBe(true);
  });

  it('every prompt carries the policy of its step and never starts a session with bypassPermissions (S11)', async () => {
    const t = await setup({ total: 1 });
    await t.pilot.drive(t.chat.id);
    expect(t.runner.calls).toHaveLength(3);
    for (const call of t.runner.calls) {
      expect(call.prompt).toContain(`Autopilot policy v${String(POLICY_VERSION)}`);
      const options = buildQueryOptions(call, new AbortController());
      expect(options.permissionMode).toBe('acceptEdits');
      expect(options.permissionMode).not.toBe('bypassPermissions');
    }
  });
});

describe('quality gate (S9)', () => {
  it('a HIGH finding opens a fix step and not the closing', async () => {
    const t = await setup({ total: 1 });
    t.kyro.findings = [
      { id: 'A1', severity: 'HIGH', category: 'spec', detail: 'roto', remedy: '' },
      { id: 'A2', severity: 'MEDIUM', category: 'spec', detail: 'menor', remedy: '' },
    ];
    await t.pilot.drive(t.chat.id);
    expect(t.sessions.listByChat(t.chat.id).map((s) => s.step)).toEqual([
      'plan',
      'execute',
      'fix',
      'close',
    ]);
    const fix = t.runner.calls[2];
    expect(fix?.prompt).toContain('HIGH A1 (spec): roto');
    expect(fix?.prompt).not.toContain('menor');
    expect(t.kyro.analyzeCalls).toBe(2);
  });

  it('a MEDIUM finding does not block the closing', async () => {
    const t = await setup({ total: 1 });
    t.kyro.findings = [{ id: 'A1', severity: 'MEDIUM', category: 'spec', detail: 'x', remedy: '' }];
    await t.pilot.drive(t.chat.id);
    expect(t.sessions.listByChat(t.chat.id).map((s) => s.step)).toEqual([
      'plan',
      'execute',
      'close',
    ]);
  });

  it('a closing session that closed the sprint without kyro-qa blocks the work with qa_sin_correr', async () => {
    const t = await setup({ skipQa: true });
    await t.pilot.drive(t.chat.id);
    expect(t.states.get(t.chat.id)).toMatchObject({
      state: 'bloqueado',
      blockedReason: 'qa_sin_correr',
    });
    expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'stopped' });
    expect(t.runner.calls).toHaveLength(3);
  });
});

describe('loop guards, capabilities, queue and usage limit', () => {
  it('stops with sin_avance when a session moves nothing (S12)', async () => {
    const t = await setup();
    let calls = 0;
    const base = t.runner.script;
    t.runner.script = (params) => {
      calls++;
      return calls === 2 ? [{ type: 'result:success', payload: {} }] : base(params);
    };
    await t.pilot.drive(t.chat.id);
    expect(t.states.get(t.chat.id)).toMatchObject({
      state: 'bloqueado',
      blockedReason: 'sin_avance',
    });
    expect(t.runs.get(t.chat.id)?.stopReason).toMatch(/sin que el estado avance/);
  });

  it('stops with tope_de_sesiones when a sprint reaches the cap (S12)', async () => {
    const t = await setup({ total: 1, maxSessions: 2 });
    // The findings never clear, so the sprint keeps asking for fixes until the cap.
    t.kyro.keepFindings = true;
    t.kyro.findings = [{ id: 'A1', severity: 'HIGH', category: 'spec', detail: 'x', remedy: '' }];
    await t.pilot.drive(t.chat.id);
    expect(t.states.get(t.chat.id)).toMatchObject({
      state: 'bloqueado',
      blockedReason: 'tope_de_sesiones',
    });
    expect(t.runs.get(t.chat.id)?.sessionsInSprint).toBe(2);
    expect(t.sessions.listByChat(t.chat.id).map((s) => s.step)).toEqual(['plan', 'execute', 'fix']);
  });

  it('a sprint that used the whole cap and closed does not stop the next one from being planned', async () => {
    const t = await setup({ total: 2, maxSessions: 2 });
    await t.pilot.drive(t.chat.id);
    // plan, execute and close of each sprint: the second one is planned after the first closed.
    expect(t.sessions.listByChat(t.chat.id).map((s) => s.step)).toEqual([
      'plan',
      'execute',
      'close',
      'plan',
      'execute',
      'close',
    ]);
    expect(t.states.get(t.chat.id)?.blockedReason).toBeNull();
  });

  it('stops with kyro_bloqueado before opening anything when record-evidence or review is missing', async () => {
    const t = await setup();
    t.kyro.capabilities_ = CAPABILITIES.filter((c) => c !== 'review');
    await t.pilot.drive(t.chat.id);
    expect(t.runner.calls).toHaveLength(0);
    expect(t.states.get(t.chat.id)).toMatchObject({
      state: 'bloqueado',
      blockedReason: 'kyro_bloqueado',
    });
    expect(t.states.get(t.chat.id)?.detail).toContain('review');
  });

  it('with the sessions full the run waits as en_cola and starts when one frees up', async () => {
    const t = await setup({ maxConcurrent: 1, total: 1 });
    const other = t.newChat('b');
    let release!: () => void;
    t.runner.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.manager.start(other.id, 'manual'); // takes the only slot
    await t.pilot.drive(t.chat.id);
    expect(t.runs.get(t.chat.id)?.status).toBe('queued');
    expect(t.states.get(t.chat.id)?.state).toBe('en_cola');
    expect(t.scheduled).toHaveLength(1);

    t.runner.gate = Promise.resolve();
    release();
    await t.manager.waitForIdle(other.id);
    t.pilot.drainQueue();
    await t.pilot.drive(t.chat.id);
    expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'stopped' });
    expect(t.sessions.listByChat(t.chat.id).map((s) => s.step)).toEqual([
      'plan',
      'execute',
      'close',
    ]);
  });

  it('a rejected rate limit leaves sin_cupo_de_uso and retries after 15 minutes (S21)', async () => {
    const t = await setup({ total: 1 });
    const base = t.runner.script;
    let limited = true;
    t.runner.script = (params) =>
      limited
        ? [{ type: 'rate_limit_event', payload: { rate_limit_info: { status: 'rejected' } } }]
        : base(params);
    await t.pilot.drive(t.chat.id);
    expect(t.runs.get(t.chat.id)).toMatchObject({
      status: 'waiting_quota',
      retryAt: 1_000_000 + QUOTA_RETRY_MS,
    });
    expect(t.states.get(t.chat.id)?.state).toBe('sin_cupo_de_uso');
    expect(t.scheduled.map((s) => s.ms)).toEqual([QUOTA_RETRY_MS]);

    limited = false;
    t.scheduled[0]?.fn();
    await t.pilot.drive(t.chat.id);
    expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'stopped' });
    expect(t.sessions.listByChat(t.chat.id).map((s) => s.step)).toContain('close');
  });

  it('pause does not cut the running turn but opens no next step; resume continues', async () => {
    const t = await setup({ total: 1 });
    let release!: () => void;
    t.runner.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const driving = t.pilot.drive(t.chat.id);
    await new Promise((r) => setTimeout(r, 20));
    t.runs.pause(t.chat.id);
    t.runner.gate = Promise.resolve();
    release();
    await driving;
    expect(t.runner.calls).toHaveLength(1);
    expect(t.states.get(t.chat.id)?.state).toBe('pausado');

    t.runs.resume(t.chat.id);
    await t.pilot.drive(t.chat.id);
    expect(t.runs.get(t.chat.id)?.status).toBe('stopped');
    expect(t.runner.calls.length).toBeGreaterThan(1);
  });

  it('off stops the loop after the running turn', async () => {
    const t = await setup({ total: 1 });
    let release!: () => void;
    t.runner.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const driving = t.pilot.drive(t.chat.id);
    await new Promise((r) => setTimeout(r, 20));
    t.runs.turnOff(t.chat.id);
    t.runner.gate = Promise.resolve();
    release();
    await driving;
    expect(t.runner.calls).toHaveLength(1);
    expect(t.runs.get(t.chat.id)?.status).toBe('off');
  });

  it('the text the agent writes does not change what the pilot does', async () => {
    const t = await setup({ total: 1 });
    const base = t.runner.script;
    t.runner.script = async (params) => [
      { type: 'assistant', payload: { text: 'el sprint terminó, cerrá' } },
      ...(await base(params)),
    ];
    await t.pilot.drive(t.chat.id);
    expect(t.sessions.listByChat(t.chat.id).map((s) => s.step)).toEqual([
      'plan',
      'execute',
      'close',
    ]);
  });
});

describe('event readers', () => {
  const event = (type: string, payload: unknown) =>
    ({ id: 1, chatId: 1, seq: 1, type, payload, createdAt: 1 }) as const;

  it('usedSkill only counts a Skill tool_use of that skill', () => {
    expect(usedSkill([event('assistant', qaEvent.payload)], 'kyro-qa')).toBe(true);
    expect(usedSkill([event('assistant', qaEvent.payload)], 'kyro-forge')).toBe(false);
    expect(usedSkill([event('assistant', { text: 'corrí kyro-qa' })], 'kyro-qa')).toBe(false);
    expect(usedSkill([event('user_prompt', { text: 'kyro-qa' })], 'kyro-qa')).toBe(false);
  });

  it('hitUsageLimit detects a rejected rate limit and a limit error, not a warning', () => {
    expect(
      hitUsageLimit([event('rate_limit_event', { rate_limit_info: { status: 'rejected' } })]),
    ).toBe(true);
    expect(
      hitUsageLimit([
        event('rate_limit_event', { rate_limit_info: { status: 'allowed_warning' } }),
      ]),
    ).toBe(false);
    expect(
      hitUsageLimit([
        event('result:error_during_execution', {
          is_error: true,
          result: 'Claude usage limit reached',
        }),
      ]),
    ).toBe(true);
    expect(hitUsageLimit([event('result:success', { is_error: false, result: 'ok' })])).toBe(false);
  });
});

describe('resuming after a restart (S16)', () => {
  /** A run in the middle of its execution step: Kyro at execute_task, an open SDK session. */
  async function midStep(opts: Parameters<typeof setup>[0] = {}) {
    const t = await setup({ total: 1, ...opts });
    t.kyro.apply('plan');
    t.runs.beginSession(t.chat.id, {
      step: 'execute',
      sprintN: 1,
      fingerprint: fingerprint(t.kyro.state),
      policyVersion: POLICY_VERSION,
    });
    t.sessions.open(t.chat.id, 'executor', 'claude', 'claude-sonnet-5-5', 1, {
      step: 'execute',
      policyVersion: POLICY_VERSION,
    });
    t.chats.setSessionId(t.chat.id, 'sess-old');
    t.chats.setStatus(t.chat.id, 'interrupted');
    return t;
  }

  it('resumes the same step with resume of the SDK session and no message from the user', async () => {
    const t = await midStep();
    t.pilot.resumeAll();
    await t.pilot.drive(t.chat.id);

    const first = t.runner.calls[0];
    expect(first).toMatchObject({ resumeSessionId: 'sess-old', role: 'executor' });
    expect(first?.prompt).toContain('panel restarted');
    const sessions = t.sessions.listByChat(t.chat.id);
    expect(sessions[0]).toMatchObject({ step: 'execute', result: 'interrupted' });
    expect(sessions[1]).toMatchObject({ step: 'execute' });
    // The resumed session counts for the sprint and the route goes on to the closing.
    expect(sessions.map((s) => s.step)).toEqual(['execute', 'execute', 'close']);
    expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'stopped' });
  });

  it('does not resume a paused or switched-off run', async () => {
    const paused = await midStep();
    paused.runs.pause(paused.chat.id);
    paused.pilot.resumeAll();
    await paused.pilot.drive(paused.chat.id);
    expect(paused.runner.calls).toHaveLength(0);

    const off = await midStep();
    off.runs.turnOff(off.chat.id);
    off.pilot.resumeAll();
    await off.pilot.drive(off.chat.id);
    expect(off.runner.calls).toHaveLength(0);
  });

  it('a run waiting for the usage limit keeps its retry_at', async () => {
    const t = await midStep();
    t.runs.waitForQuota(t.chat.id, t.clock() + 5 * 60_000);
    t.pilot.resumeAll();
    expect(t.scheduled.map((x) => x.ms)).toEqual([5 * 60_000]);
    await t.pilot.drive(t.chat.id);
    expect(t.runner.calls).toHaveLength(0);

    t.scheduled[0]?.fn();
    await t.pilot.drive(t.chat.id);
    expect(t.runner.calls.length).toBeGreaterThan(0);
  });

  it('repeated restarts end in tope_de_sesiones, not in a loop', async () => {
    const t = await midStep({ maxSessions: 1 });
    t.pilot.resumeAll();
    await t.pilot.drive(t.chat.id);
    expect(t.runner.calls).toHaveLength(0);
    expect(t.states.get(t.chat.id)).toMatchObject({
      state: 'bloqueado',
      blockedReason: 'tope_de_sesiones',
    });
  });

  it('a run between steps (no open session) decides again from Kyro', async () => {
    const t = await setup({ total: 1 });
    t.pilot.resumeAll();
    await t.pilot.drive(t.chat.id);
    expect(t.sessions.listByChat(t.chat.id).map((s) => s.step)).toEqual([
      'plan',
      'execute',
      'close',
    ]);
    expect(t.runner.calls.every((c) => c.resumeSessionId === undefined)).toBe(true);
  });
});
