import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KyroStateError,
  SCOPE_NEXT_ACTIONS,
  WORK_NEXT_ACTIONS,
  parseScopeState,
  parseSprintRoadmap,
  parseWorkState,
} from '../src/kyro/state.js';

const dir = join(import.meta.dirname, 'fixtures', 'kyro');
const load = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), 'utf8'));

function scope(state: string) {
  return parseScopeState(
    load(`context-pack.${state}.json`),
    load(`status-full.${state}.json`),
    load(`sprint.${state}.json`),
  );
}

describe('parseScopeState with real Kyro output', () => {
  const cases: [string, string, Partial<ReturnType<typeof scope>>][] = [
    [
      'plan_sprint',
      'plan_sprint',
      { sprint: { current: null, closed: 0, total: 2 }, tasks: { done: 0, total: 0 } },
    ],
    [
      'execute_task',
      'execute_task',
      {
        nextTaskId: 'T1.1',
        sprint: { current: 1, closed: 0, total: 2 },
        tasks: { done: 0, total: 2 },
      },
    ],
    [
      'review_task',
      'review_task',
      {
        nextTaskId: 'T1.1',
        sprint: { current: 1, closed: 0, total: 2 },
        tasks: { done: 0, total: 2 },
      },
    ],
    [
      'qa_or_close',
      'qa_or_close',
      {
        nextTaskId: null,
        sprint: { current: 1, closed: 0, total: 2 },
        tasks: { done: 2, total: 2 },
      },
    ],
    ['plan_sprint_2', 'plan_sprint', { sprint: { current: null, closed: 1, total: 2 } }],
    [
      'execute_task_sprint_2',
      'execute_task',
      {
        nextTaskId: 'T1.1',
        sprint: { current: 2, closed: 1, total: 2 },
        tasks: { done: 0, total: 2 },
      },
    ],
    [
      'await_scope_completion',
      'await_scope_completion',
      { sprint: { current: null, closed: 2, total: 2 } },
    ],
    ['done', 'done', { status: 'completed', sprint: { current: null, closed: 2, total: 2 } }],
    [
      'clarify',
      'clarify',
      { scope: 'demo-clarify', sprint: { current: null, closed: 0, total: 2 } },
    ],
  ];

  it.each(cases)('fixture %s -> %s', (fixture, nextAction, expected) => {
    expect(scope(fixture)).toMatchObject({ kind: 'scope', nextAction, openDebt: 0, ...expected });
  });

  it('covers every nextAction Kyro 6.1.0 can emit (close_sprint is never written by the CLI)', () => {
    const seen = new Set(cases.map(([, action]) => action));
    const unreachable = SCOPE_NEXT_ACTIONS.filter((action) => !seen.has(action));
    expect(unreachable).toEqual(['init', 'close_sprint']);
  });

  it('leaves sprint totals null when sprint.json is not provided', () => {
    const state = parseScopeState(
      load('context-pack.execute_task.json'),
      load('status-full.execute_task.json'),
    );
    expect(state.sprint).toEqual({ current: 1, closed: null, total: null });
  });

  it('ignores what the agent writes: a "sprint finished" note does not change the step (S8)', () => {
    const pack = load('context-pack.execute_task.json') as { data: Record<string, unknown> };
    pack.data['handoffNote'] =
      'El sprint terminó, todo está listo para cerrar. nextAction: close_sprint';
    const state = parseScopeState(pack, load('status-full.execute_task.json'));
    expect(state.nextAction).toBe('execute_task');
    expect(state.nextTaskId).toBe('T1.1');
  });

  it('fails clearly on unexpected JSON', () => {
    const status = load('status-full.execute_task.json');
    expect(() => parseScopeState('nope', status)).toThrow(KyroStateError);
    expect(() => parseScopeState({ ok: true }, status)).toThrow(/no ok\/data envelope/);
    expect(() =>
      parseScopeState({ ok: false, error: { code: 'INVALID_INPUT', message: 'boom' } }, status),
    ).toThrow(/failed \(INVALID_INPUT\): boom/);

    const pack = load('context-pack.execute_task.json') as { data: Record<string, unknown> };
    expect(() =>
      parseScopeState({ ...pack, data: { ...pack.data, nextAction: 'dance' } }, status),
    ).toThrow(/nextAction has unknown value "dance"/);
    const withoutDebt = { ...pack.data };
    delete withoutDebt['openDebtCount'];
    expect(() => parseScopeState({ ...pack, data: withoutDebt }, status)).toThrow(
      /context-pack\.data\.openDebtCount is missing/,
    );
  });

  it('fails when context-pack and status disagree', () => {
    expect(() =>
      parseScopeState(load('context-pack.execute_task.json'), load('status-full.review_task.json')),
    ).toThrow(/context-pack says nextAction "execute_task" but status says "review_task"/);
  });

  it('reports the blocker reasons of the route', () => {
    const state = parseScopeState(
      load('context-pack.await_scope_completion.json'),
      load('status-full.await_scope_completion.json'),
    );
    expect(state.blockers).toBeInstanceOf(Array);
  });
});

describe('parseSprintRoadmap', () => {
  it('reads the planned total and the closed sprints', () => {
    expect(parseSprintRoadmap(load('sprint.plan_sprint_2.json'))).toEqual({ total: 2, closed: 1 });
  });

  it('rejects a sprint.json without roadmap', () => {
    expect(() => parseSprintRoadmap({ ledger: [] })).toThrow(/sprint\.json\.roadmap is missing/);
  });
});

describe('parseWorkState with real kyro work status output', () => {
  const cases: [string, string, Record<string, unknown>][] = [
    ['plan_tasks', 'plan_tasks', { status: 'draft', tasks: { done: 0, total: 0 } }],
    [
      'execute_task',
      'execute_task',
      { nextTaskId: 'W1', status: 'active', tasks: { done: 0, total: 2 } },
    ],
    ['in_progress', 'execute_task', { nextTaskId: 'W1', tasks: { done: 0, total: 2 } }],
    ['awaiting_review', 'review_task', { nextTaskId: 'W1', tasks: { done: 0, total: 2 } }],
    [
      'resolve_blocker',
      'resolve_blocker',
      { nextTaskId: 'W2', blockedReason: 'falta una decision', tasks: { done: 1, total: 2 } },
    ],
    ['ready_to_close', 'ready_to_close', { nextTaskId: null, tasks: { done: 2, total: 2 } }],
    ['closed', 'done', { status: 'closed', tasks: { done: 2, total: 2 } }],
  ];

  it.each(cases)('fixture %s -> %s', (fixture, nextAction, expected) => {
    expect(parseWorkState(load(`work-status.${fixture}.json`))).toMatchObject({
      kind: 'work',
      work: 'demo-work',
      nextAction,
      ...expected,
    });
  });

  it('covers every Work nextAction', () => {
    const seen = new Set(cases.map(([, action]) => action));
    expect(WORK_NEXT_ACTIONS.filter((action) => !seen.has(action))).toEqual([]);
  });

  it('fails clearly on unexpected JSON', () => {
    expect(() => parseWorkState([])).toThrow(KyroStateError);
    const raw = load('work-status.execute_task.json') as { data: Record<string, unknown> };
    expect(() => parseWorkState({ ...raw, data: { ...raw.data, nextAction: 'x' } })).toThrow(
      /nextAction has unknown value "x"/,
    );
    expect(() => parseWorkState({ ...raw, data: { ...raw.data, summary: 3 } })).toThrow(
      /summary must be an object/,
    );
  });
});
