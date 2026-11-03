import { describe, expect, it } from 'vitest';
import {
  chatBadge,
  chatSubtitle,
  hasRunning,
  kindChipLabel,
  sidebarBadge,
  statusTone,
} from './status';

describe('chat status helpers', () => {
  it('polls only while some chat is running', () => {
    expect(hasRunning([{ status: 'idle' }, { status: 'running' }])).toBe(true);
    expect(hasRunning([{ status: 'idle' }, { status: 'error' }])).toBe(false);
    expect(hasRunning([])).toBe(false);
  });

  it('shows only the branch as subtitle (the kind is a chip)', () => {
    expect(chatSubtitle({ branch: 'feature/fix-login' })).toBe('feature/fix-login');
    expect(chatSubtitle({ branch: 'feature/panel' })).toBe('feature/panel');
  });

  it('labels the kind chip', () => {
    expect(kindChipLabel('scope')).toBe('Scope');
    expect(kindChipLabel('work')).toBe('Work');
    expect(kindChipLabel('idea')).toBe('Idea');
    expect(kindChipLabel('direct')).toBe('Directo');
  });

  it('maps each status to a badge tone', () => {
    expect(statusTone('running')).toBe('accent');
    expect(statusTone('idle')).toBe('ok');
    expect(statusTone('error')).toBe('danger');
    expect(statusTone('interrupted')).toBe('warn');
  });
});

describe('chatBadge', () => {
  it("says it is the user's turn (amber) while the agent waits for an answer", () => {
    expect(chatBadge('running', true)).toEqual({ label: 'Esperando tu respuesta', tone: 'warn' });
  });

  it('falls back to the session status otherwise', () => {
    expect(chatBadge('running', false)).toEqual({ label: 'En curso', tone: 'accent' });
    expect(chatBadge('idle', false).label).toBe('En espera');
    // A pending question of a chat that is no longer running does not change its badge.
    expect(chatBadge('cancelled', true).label).toBe('Cancelado');
  });
});

describe('sidebarBadge', () => {
  it('shows the state of the work with the tone of who has to move', () => {
    expect(sidebarBadge({ status: 'idle', workState: 'madurando_idea' })).toEqual({
      label: 'Madurando la idea',
      tone: 'accent',
    });
    expect(sidebarBadge({ status: 'idle', workState: 'esperando_aprobacion_plan' })).toEqual({
      label: 'Esperando aprobación del plan',
      tone: 'warn',
    });
    expect(sidebarBadge({ status: 'running', workState: 'pr_lista' }).tone).toBe('ok');
  });

  it('tells what «Planificando» is about: general, the scope or a sprint', () => {
    const base = { status: 'running', workState: 'planificando' } as const;
    expect(sidebarBadge(base)).toEqual({ label: 'Planificando', tone: 'accent' });
    expect(sidebarBadge({ ...base, planning: { target: 'general', sprint: null } }).label).toBe(
      'Planificando',
    );
    expect(sidebarBadge({ ...base, planning: { target: 'scope', sprint: null } }).label).toBe(
      'Planificando scope',
    );
    expect(sidebarBadge({ ...base, planning: { target: 'sprint', sprint: 3 } })).toEqual({
      label: 'Planificando sprint 3',
      tone: 'accent',
    });
  });

  it('leaves the other states as they are, whatever the planning says', () => {
    expect(
      sidebarBadge({
        status: 'running',
        workState: 'escribiendo_codigo',
        planning: { target: 'sprint', sprint: 2 },
      }).label,
    ).toBe('Escribiendo código');
  });

  it('falls back to the session status for a direct request or a work without state yet', () => {
    expect(sidebarBadge({ status: 'idle', workState: null })).toEqual({
      label: 'En espera',
      tone: 'ok',
    });
    expect(sidebarBadge({ status: 'error' })).toEqual({ label: 'Error', tone: 'danger' });
  });
});
