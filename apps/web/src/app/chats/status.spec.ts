import { describe, expect, it } from 'vitest';
import { chatBadge, chatSubtitle, hasRunning, sidebarBadge, statusTone } from './status';

describe('chat status helpers', () => {
  it('polls only while some chat is running', () => {
    expect(hasRunning([{ status: 'idle' }, { status: 'running' }])).toBe(true);
    expect(hasRunning([{ status: 'idle' }, { status: 'error' }])).toBe(false);
    expect(hasRunning([])).toBe(false);
  });

  it('identifies a chat by kind and branch', () => {
    expect(chatSubtitle({ kind: 'work', branch: 'feature/fix-login' })).toBe(
      'work · feature/fix-login',
    );
    expect(chatSubtitle({ kind: 'scope', branch: 'feature/panel' })).toBe('scope · feature/panel');
    expect(chatSubtitle({ kind: 'direct', branch: 'feature/ajuste' })).toBe(
      'directo · feature/ajuste',
    );
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

  it('falls back to the session status for a direct request or a work without state yet', () => {
    expect(sidebarBadge({ status: 'idle', workState: null })).toEqual({
      label: 'En espera',
      tone: 'ok',
    });
    expect(sidebarBadge({ status: 'error' })).toEqual({ label: 'Error', tone: 'danger' });
  });
});
