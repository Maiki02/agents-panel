import { describe, expect, it } from 'vitest';
import { currentTaskView } from './phase-logic';
import { taskLines } from './work-info-panel';

const base = {
  previousState: null,
  blockedReason: null,
  detail: null,
  sprintCurrent: null,
  sprintTotal: null,
  taskDone: null,
  taskTotal: null,
  taskTitle: null,
} as const;

describe('title of the current task (info icon tooltip)', () => {
  it('carries the title Kyro printed for the task being worked on', () => {
    const view = currentTaskView({
      ...base,
      state: 'escribiendo_codigo',
      taskId: 'T3.1',
      taskTitle: '  Servicio de relogueo  ',
    });
    expect(view).toMatchObject({ id: 'T3.1', title: 'Servicio de relogueo' });
  });

  it('is null without a title or without a task, so no icon is shown', () => {
    expect(
      currentTaskView({ ...base, state: 'probando', taskId: 'T3.1', taskTitle: null })?.title,
    ).toBeNull();
    expect(
      currentTaskView({ ...base, state: 'probando', taskId: 'T3.1', taskTitle: '   ' })?.title,
    ).toBeNull();
    expect(
      currentTaskView({ ...base, state: 'planificando', taskId: null, taskTitle: 'Huérfano' })
        ?.title,
    ).toBeNull();
  });
});

describe('current task card lines', () => {
  it('without a task id the activity is the main line and there is no id line', () => {
    const view = currentTaskView({ ...base, state: 'planificando', taskId: null });
    expect(view).not.toBeNull();
    if (view === null) return;
    const lines = taskLines(view);
    expect(lines.title).toBeNull();
    expect(lines.activity).toBe('Planificando');
  });

  it('with a task id keeps the id and the activity', () => {
    const view = currentTaskView({ ...base, state: 'probando', taskId: 'W2' });
    expect(view).not.toBeNull();
    if (view === null) return;
    const lines = taskLines(view);
    expect(lines.title).toBe('W2');
    expect(lines.activity).toBe(view.activity);
  });
});
