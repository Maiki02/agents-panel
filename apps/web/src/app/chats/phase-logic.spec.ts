import { describe, expect, it } from 'vitest';
import { WORKTREE_STATE_IDS } from '@agents-panel/shared';
import { PHASES, phaseOf, sessionLabel, stepperView } from './phase-logic';

const base = {
  previousState: null,
  sprintCurrent: null,
  sprintTotal: null,
  taskDone: null,
  taskTotal: null,
  role: null,
  model: null,
} as const;

describe('phaseOf', () => {
  it('maps the working states to their phase', () => {
    expect(phaseOf('madurando_idea')).toBe('idea');
    expect(phaseOf('planificando')).toBe('plan');
    expect(phaseOf('escribiendo_codigo')).toBe('execution');
    expect(phaseOf('qa')).toBe('qa');
    expect(phaseOf('esperando_aprobacion_cierre')).toBe('close');
    expect(phaseOf('abriendo_pr')).toBe('merge');
    expect(phaseOf('pr_lista')).toBe('pr');
  });

  it('keeps the phase of the previous state when the work was interrupted', () => {
    expect(phaseOf('bloqueado', 'qa')).toBe('qa');
    expect(phaseOf('pausado', 'escribiendo_codigo')).toBe('execution');
    expect(phaseOf('bloqueado')).toBeNull();
    expect(phaseOf('error', 'bloqueado')).toBeNull();
  });

  it('every phase of a state belongs to the list', () => {
    const ids = PHASES.map((p) => p.id) as string[];
    for (const state of WORKTREE_STATE_IDS) {
      const phase = phaseOf(state);
      if (phase !== null) expect(ids, state).toContain(phase);
    }
  });
});

describe('stepperView', () => {
  it('marks done, current and upcoming steps', () => {
    const view = stepperView({ ...base, state: 'qa' });
    expect(view.steps.map((s) => s.status)).toEqual([
      'done',
      'done',
      'done',
      'current',
      'upcoming',
      'upcoming',
      'upcoming',
    ]);
    expect(view.current).toBe('QA');
  });

  it('shows sprint and task only when the numbers come, never invents them', () => {
    expect(stepperView({ ...base, state: 'qa' })).toMatchObject({ sprint: null, task: null });
    expect(
      stepperView({
        ...base,
        state: 'qa',
        sprintCurrent: 2,
        sprintTotal: 3,
        taskDone: 1,
        taskTotal: 4,
      }),
    ).toMatchObject({ sprint: 'Sprint 2/3', task: 'Tarea 1/4' });
    expect(stepperView({ ...base, state: 'qa', sprintCurrent: 2 }).sprint).toBeNull();
    expect(stepperView({ ...base, state: 'qa', taskDone: 0, taskTotal: 0 }).task).toBeNull();
  });

  it('has no current step without a state or a known phase', () => {
    for (const view of [stepperView(null), stepperView({ ...base, state: 'bloqueado' })]) {
      expect(view.current).toBeNull();
      expect(view.steps.every((s) => s.status === 'upcoming')).toBe(true);
    }
  });

  it('shows the role and model of the session', () => {
    expect(
      stepperView({ ...base, state: 'planificando', role: 'thinker', model: 'opus' }).session,
    ).toBe('Pensante · opus');
    expect(stepperView({ ...base, state: 'planificando' }).session).toBeNull();
    expect(sessionLabel('executor', null)).toBe('Ejecutor');
  });
});
