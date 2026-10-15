import { describe, expect, it } from 'vitest';
import { currentTaskView, stepperView } from './phase-logic';
import { taskDetail } from './phase-stepper';

const base = {
  previousState: null,
  blockedReason: null,
  detail: null,
  sprintCurrent: null,
  sprintTotal: null,
  taskDone: null,
  taskTotal: null,
  role: null,
  model: null,
} as const;

describe('phase stepper timeline data', () => {
  it('joins the task id and its activity for the current phase', () => {
    const view = currentTaskView({ ...base, state: 'escribiendo_codigo', taskId: 'W5' });
    expect(taskDetail(view)).toBe('W5 · Escribiendo código');
  });

  it('shows only the activity when Kyro has no task id', () => {
    const view = currentTaskView({ ...base, state: 'planificando', taskId: null });
    expect(taskDetail(view)).toBe('Planificando');
  });

  it('has no detail without task activity', () => {
    expect(taskDetail(null)).toBeNull();
  });

  it('marks one phase current, the earlier ones done and the rest upcoming', () => {
    const { steps } = stepperView({ ...base, state: 'escribiendo_codigo' });
    const statuses = steps.map((s) => s.status);
    const at = statuses.indexOf('current');
    expect(at).toBeGreaterThan(0);
    expect(statuses.filter((s) => s === 'current')).toHaveLength(1);
    expect(statuses.slice(0, at).every((s) => s === 'done')).toBe(true);
    expect(statuses.slice(at + 1).every((s) => s === 'upcoming')).toBe(true);
  });
});
