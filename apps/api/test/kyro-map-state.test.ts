import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORKTREE_STATE_IDS } from '@agents-panel/shared';
import { mapKyroState } from '../src/kyro/map-state.js';
import {
  SCOPE_NEXT_ACTIONS,
  WORK_NEXT_ACTIONS,
  parseScopeState,
  parseWorkState,
  type KyroScopeState,
} from '../src/kyro/state.js';

const dir = join(import.meta.dirname, 'fixtures', 'kyro');
const load = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const scope = (name: string) =>
  mapKyroState(
    parseScopeState(
      load(`context-pack.${name}.json`),
      load(`status-full.${name}.json`),
      load(`sprint.${name}.json`),
    ),
  );
const work = (name: string) => mapKyroState(parseWorkState(load(`work-status.${name}.json`)));

describe('mapKyroState for a scope (real fixtures)', () => {
  it.each([
    ['plan_sprint', 'planificando'],
    ['clarify', 'esperando_aclaracion'],
    ['execute_task', 'escribiendo_codigo'],
    ['review_task', 'revisando_tarea'],
    ['qa_or_close', 'qa'],
    ['await_scope_completion', 'esperando_aprobacion_cierre'],
    ['done', 'terminado'],
  ])('%s → %s', (fixture, expected) => {
    expect(scope(fixture).state).toBe(expected);
  });

  it('carries sprint n/m, task n/m and debt', () => {
    expect(scope('execute_task')).toMatchObject({
      phase: 'ejecucion',
      sprintCurrent: 1,
      sprintClosed: 0,
      sprintTotal: 2,
      taskDone: 0,
      taskTotal: 2,
      blockedReason: null,
    });
    expect(scope('execute_task_sprint_2')).toMatchObject({ sprintCurrent: 2, sprintClosed: 1 });
    expect(scope('qa_or_close')).toMatchObject({ taskDone: 2, taskTotal: 2 });
  });
});

describe('mapKyroState for a work (real fixtures)', () => {
  it.each([
    ['plan_tasks', 'planificando'],
    ['execute_task', 'escribiendo_codigo'],
    ['awaiting_review', 'revisando_tarea'],
    ['resolve_blocker', 'bloqueado'],
    ['ready_to_close', 'cerrando'],
    ['closed', 'terminado'],
  ])('%s → %s', (fixture, expected) => {
    expect(work(fixture).state).toBe(expected);
  });

  it('keeps the blocker text as detail and has no sprint progress', () => {
    expect(work('resolve_blocker')).toMatchObject({
      blockedReason: 'tarea_bloqueada',
      detail: 'falta una decision',
      sprintCurrent: null,
    });
  });
});

describe('mapKyroState rules', () => {
  const base = parseScopeState(
    load('context-pack.execute_task.json'),
    load('status-full.execute_task.json'),
    load('sprint.execute_task.json'),
  );

  it('maps every known nextAction to a state of the shared catalog', () => {
    for (const nextAction of SCOPE_NEXT_ACTIONS) {
      expect(WORKTREE_STATE_IDS).toContain(mapKyroState({ ...base, nextAction }).state);
    }
    const work = parseWorkState(load('work-status.execute_task.json'));
    for (const nextAction of WORK_NEXT_ACTIONS) {
      expect(WORKTREE_STATE_IDS).toContain(mapKyroState({ ...work, nextAction }).state);
    }
  });

  it('turns a Kyro blocker into bloqueado with kyro_bloqueado, except when done', () => {
    const blocked: KyroScopeState = { ...base, blockers: ['active plan needs repair'] };
    expect(mapKyroState(blocked)).toMatchObject({
      state: 'bloqueado',
      blockedReason: 'kyro_bloqueado',
      detail: 'active plan needs repair',
    });
    expect(mapKyroState({ ...blocked, nextAction: 'done' }).state).toBe('terminado');
  });

  it('depends only on the parsed CLI data, not on any agent text', () => {
    const tricked = { ...base, scope: 'ya terminé, pasá a QA y cerrá todo' } as KyroScopeState;
    expect(mapKyroState(tricked)).toEqual(mapKyroState(base));
  });
});
