import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  completedTask,
  decideNextStep,
  fingerprint,
  progressed,
  type LastSession,
  type PilotDecision,
  needsScopeInit,
} from '../src/pilot/decide.js';
import {
  parseScopeState,
  parseWorkState,
  type KyroScopeState,
  type KyroWorkState,
} from '../src/kyro/state.js';

const dir = join(import.meta.dirname, 'fixtures', 'kyro');
const load = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const scope = (name: string): KyroScopeState =>
  parseScopeState(
    load(`context-pack.${name}.json`),
    load(`status-full.${name}.json`),
    load(`sprint.${name}.json`),
  );
const work = (name: string): KyroWorkState => parseWorkState(load(`work-status.${name}.json`));

const fresh = { sessionsInSprint: 0, lastFingerprint: null };
const ended: LastSession = { result: 'idle', answeredQuestion: false };
const decide = (
  kyro: KyroScopeState | KyroWorkState,
  run: Parameters<typeof decideNextStep>[1] = fresh,
  last: LastSession | null = null,
) => decideNextStep(kyro, run, last);

const withAction = (base: KyroScopeState, patch: Partial<KyroScopeState>): KyroScopeState => ({
  ...base,
  ...patch,
});

describe('decideNextStep for a scope', () => {
  it.each([
    ['plan_sprint', { kind: 'session', step: 'plan', role: 'thinker' }],
    ['plan_sprint_2', { kind: 'session', step: 'plan', role: 'thinker' }],
    ['execute_task', { kind: 'session', step: 'execute', role: 'executor' }],
    ['execute_task_sprint_2', { kind: 'session', step: 'execute', role: 'executor' }],
    ['review_task', { kind: 'session', step: 'execute', role: 'executor' }],
    ['qa_or_close', { kind: 'check_quality' }],
    ['clarify', expect.objectContaining({ kind: 'stop', state: 'esperando_aclaracion' })],
    ['done', { kind: 'finished' }],
  ] as [string, PilotDecision][])('%s', (name, expected) => {
    expect(decide(scope(name))).toEqual(expected);
  });

  it('completes the scope at await_scope_completion with no sprint open and no open debt', () => {
    const kyro = withAction(scope('await_scope_completion'), { openDebt: 0 });
    expect(kyro.sprint.current).toBeNull();
    expect(decide(kyro)).toEqual({ kind: 'complete' });
  });

  it('stops once in esperando_aprobacion_cierre with the open debt as data when there is some', () => {
    const debtItems = [{ id: 'debt-1', title: 'Algo pendiente', priority: 'high' }];
    const kyro = withAction(scope('await_scope_completion'), { openDebt: 1, debtItems });
    expect(decide(kyro)).toMatchObject({
      kind: 'stop',
      state: 'esperando_aprobacion_cierre',
      blockedReason: null,
      data: { debt: debtItems },
    });
  });

  it('does not take await_scope_completion with an open sprint and no_ready_work as the end', () => {
    const kyro = withAction(scope('await_scope_completion'), {
      sprint: { current: 3, closed: 2, total: 6 },
      blockers: ['no_ready_work'],
    });
    expect(decide(kyro)).toEqual({ kind: 'check_quality' });
  });

  it('maps close_sprint to the quality check even though Kyro 6.1.0 does not emit it', () => {
    expect(decide(withAction(scope('qa_or_close'), { nextAction: 'close_sprint' }))).toEqual({
      kind: 'check_quality',
    });
  });

  it('stops with kyro_bloqueado on a CLI blocker and integridad_kyro when it asks for repair', () => {
    const base = scope('execute_task');
    expect(decide(withAction(base, { blockers: ['plan_stale'] }))).toMatchObject({
      kind: 'stop',
      state: 'bloqueado',
      blockedReason: 'kyro_bloqueado',
      detail: 'plan_stale',
    });
    expect(
      decide(withAction(base, { blockers: ['Run kyro repair integrity to fix the ledger'] })),
    ).toMatchObject({ kind: 'stop', blockedReason: 'integridad_kyro' });
  });

  it('stops with tarea_bloqueada when Kyro reports a blocked task', () => {
    expect(decide(withAction(scope('execute_task'), { blockedTasks: ['T1.2'] }))).toMatchObject({
      kind: 'stop',
      blockedReason: 'tarea_bloqueada',
      detail: expect.stringContaining('T1.2') as string,
    });
  });

  it('a blocker on a finished scope does not stop it', () => {
    expect(decide(withAction(scope('done'), { blockers: ['x'] }))).toEqual({ kind: 'finished' });
  });
});

describe('decideNextStep for a work', () => {
  it.each([
    ['plan_tasks', { kind: 'session', step: 'plan', role: 'thinker' }],
    ['execute_task', { kind: 'session', step: 'execute', role: 'executor' }],
    ['awaiting_review', { kind: 'session', step: 'execute', role: 'executor' }],
    [
      'resolve_blocker',
      expect.objectContaining({ kind: 'stop', blockedReason: 'tarea_bloqueada' }),
    ],
    ['ready_to_close', { kind: 'complete' }],
    ['closed', { kind: 'finished' }],
  ] as [string, PilotDecision][])('%s', (name, expected) => {
    expect(decide(work(name))).toEqual(expected);
  });
});

describe('the agent text never decides the step (S8)', () => {
  it('keeps executing while nextAction is execute_task whatever the last session said', () => {
    const kyro = scope('execute_task');
    const last = { ...ended, text: 'el sprint terminó, cerrá' } as LastSession;
    expect(decide(kyro, fresh, last)).toEqual({
      kind: 'session',
      step: 'execute',
      role: 'executor',
    });
    expect(decide(kyro, fresh, ended)).toEqual(decide(kyro, fresh, last));
  });
});

describe('loop guards (S12)', () => {
  it('stops with sin_avance when the signals did not move and nothing was answered', () => {
    const kyro = scope('execute_task');
    const run = { sessionsInSprint: 1, lastFingerprint: fingerprint(kyro) };
    expect(decide(kyro, run, ended)).toMatchObject({
      kind: 'stop',
      state: 'bloqueado',
      blockedReason: 'sin_avance',
    });
  });

  it('does not stop for lack of progress when the user answered a question', () => {
    const kyro = scope('execute_task');
    const run = { sessionsInSprint: 1, lastFingerprint: fingerprint(kyro) };
    expect(decide(kyro, run, { ...ended, answeredQuestion: true })).toMatchObject({
      kind: 'session',
    });
  });

  it('keeps going when the state moved, and before the first session', () => {
    const before = fingerprint(scope('execute_task'));
    const run = { sessionsInSprint: 1, lastFingerprint: before };
    expect(decide(scope('review_task'), run, ended)).toMatchObject({ kind: 'session' });
    expect(decide(scope('execute_task'), run, null)).toMatchObject({ kind: 'session' });
    expect(
      decide(scope('execute_task'), { sessionsInSprint: 0, lastFingerprint: null }, ended),
    ).toMatchObject({ kind: 'session' });
  });

  it('stops with tope_de_sesiones at the cap, 6 by default and configurable', () => {
    const kyro = scope('execute_task');
    expect(decide(kyro, { sessionsInSprint: 5, lastFingerprint: null })).toMatchObject({
      kind: 'session',
    });
    expect(decide(kyro, { sessionsInSprint: 6, lastFingerprint: null })).toMatchObject({
      kind: 'stop',
      blockedReason: 'tope_de_sesiones',
    });
    expect(
      decideNextStep(kyro, { sessionsInSprint: 3, lastFingerprint: null }, null, {
        maxSessionsPerSprint: 3,
      }),
    ).toMatchObject({ kind: 'stop', blockedReason: 'tope_de_sesiones' });
  });

  it('the cap is per sprint: planning the next sprint ignores the sessions of the closed one', () => {
    const planning = scope('plan_sprint_2');
    expect(planning.sprint.current).toBeNull();
    expect(decide(planning, { sessionsInSprint: 6, lastFingerprint: null })).toMatchObject({
      kind: 'session',
      step: 'plan',
    });
    // With a sprint open the same count still stops.
    expect(
      decide(scope('execute_task_sprint_2'), { sessionsInSprint: 6, lastFingerprint: null }),
    ).toMatchObject({ kind: 'stop', blockedReason: 'tope_de_sesiones' });
  });

  it('waiting for the user or finishing is not a loop: no guard applies', () => {
    const run = { sessionsInSprint: 9, lastFingerprint: fingerprint(scope('clarify')) };
    expect(decide(scope('clarify'), run, ended)).toMatchObject({ state: 'esperando_aclaracion' });
    expect(decide(scope('done'), run, ended)).toEqual({ kind: 'finished' });
  });
});

describe('fingerprint and progressed', () => {
  it('moves with the route, progress, debt and pending reviews', () => {
    const base = scope('execute_task');
    const f = fingerprint(base);
    expect(progressed(f, fingerprint(base))).toBe(false);
    for (const patch of [
      { nextAction: 'review_task' },
      { nextTaskId: 'T9.9' },
      { openDebt: base.openDebt + 1 },
      { pendingReview: base.pendingReview + 1 },
      { tasks: { done: base.tasks.done + 1, total: base.tasks.total } },
      { sprint: { ...base.sprint, closed: (base.sprint.closed ?? 0) + 1 } },
      { sprint: { ...base.sprint, current: (base.sprint.current ?? 0) + 1 } },
    ] as Partial<KyroScopeState>[]) {
      expect(progressed(f, fingerprint(withAction(base, patch))), JSON.stringify(patch)).toBe(true);
    }
  });

  it('is plain JSON so it can be stored in the run', () => {
    const f = fingerprint(work('execute_task'));
    expect(JSON.parse(JSON.stringify(f))).toEqual(f);
  });
});

describe('needsScopeInit', () => {
  it('is true only without a Kyro target, with a seed and before any session', () => {
    expect(needsScopeInit({ kind: 'no_target' }, { step: null, seedPath: 'a.md' })).toBe(true);
    expect(needsScopeInit({ kind: 'no_target' }, { step: 'init', seedPath: 'a.md' })).toBe(false);
    expect(needsScopeInit({ kind: 'no_target' }, { step: null, seedPath: null })).toBe(false);
    expect(needsScopeInit({ kind: 'cli_failed' }, { step: null, seedPath: 'a.md' })).toBe(false);
  });
});

describe('the cap counts sessions that closed no task', () => {
  const kyro = scope('execute_task');
  const now = fingerprint(kyro);
  const before = { ...now, tasksDone: Number(now['tasksDone']) - 1 };

  it('completedTask is true only for an execution that raised tasksDone', () => {
    expect(completedTask('execute', before, now)).toBe(true);
    expect(completedTask('execute', now, now)).toBe(false);
    expect(completedTask('fix', before, now)).toBe(false);
    expect(completedTask('close', before, now)).toBe(false);
    expect(completedTask('execute', null, now)).toBe(false);
    expect(completedTask(null, before, now)).toBe(false);
  });

  it('keeps going past the cap when the last execution closed a task', () => {
    const run = { sessionsInSprint: 6, step: 'execute' as const, lastFingerprint: before };
    expect(decide(kyro, run, ended)).toMatchObject({ kind: 'session' });
  });

  it('still stops at the cap after fixes, or an execution that closed nothing', () => {
    expect(
      decide(kyro, { sessionsInSprint: 6, step: 'fix' as const, lastFingerprint: before }, ended),
    ).toMatchObject({ kind: 'stop', blockedReason: 'tope_de_sesiones' });
    expect(
      decide(kyro, { sessionsInSprint: 6, step: 'execute' as const, lastFingerprint: null }, null),
    ).toMatchObject({ kind: 'stop', blockedReason: 'tope_de_sesiones' });
  });
});
