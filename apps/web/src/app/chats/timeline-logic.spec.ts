import { describe, expect, it } from 'vitest';
import type { WorktreeTransition } from '@agents-panel/shared';
import { formatRelative, formatTransition, timelineEntries } from './timeline-logic';

function transition(over: Partial<WorktreeTransition>): WorktreeTransition {
  return {
    id: 1,
    chatId: 1,
    fromState: null,
    toState: 'planificando',
    reason: null,
    actor: 'system',
    role: null,
    model: null,
    data: null,
    createdAt: 1000,
    ...over,
  };
}

describe('formatTransition', () => {
  it('shows actor, role, model and the reason of a block', () => {
    const entry = formatTransition(
      transition({
        fromState: 'qa',
        toState: 'bloqueado',
        actor: 'pilot',
        role: 'executor',
        model: 'claude-sonnet-5-5',
        reason: 'Sin avance',
      }),
    );
    expect(entry).toMatchObject({
      from: 'QA en curso',
      to: 'Bloqueado',
      tone: 'warn',
      actor: 'Piloto',
      session: 'Ejecutor · claude-sonnet-5-5',
      reason: 'Sin avance',
    });
  });

  it('has no from on the first entry, and no session or reason when there are none', () => {
    const entry = formatTransition(transition({ actor: 'user', reason: '  ' }));
    expect(entry).toMatchObject({ from: null, actor: 'Usuario', session: null, reason: null });
  });

  it('lists the postponed debt and the ADR of the pilot', () => {
    const entry = formatTransition(
      transition({
        toState: 'esperando_aprobacion_cierre',
        data: {
          debt: [{ id: 'debt-1', title: 'Falta test' }, { id: 'debt-2' }, { nope: 1 }],
          adr: { title: 'Usar SQLite', decision: 'Una sola base' },
        },
      }),
    );
    expect(entry.debt).toEqual(['debt-1 Falta test', 'debt-2']);
    expect(entry.decision).toBe('Usar SQLite: Una sola base');
    expect(formatTransition(transition({ data: { adr: 'Decisión corta' } })).decision).toBe(
      'Decisión corta',
    );
    expect(formatTransition(transition({ data: 'raro' })).debt).toEqual([]);
  });
});

describe('timelineEntries', () => {
  it('orders from the newest to the oldest', () => {
    const list = timelineEntries([
      transition({ id: 1 }),
      transition({ id: 3 }),
      transition({ id: 2 }),
    ]);
    expect(list.map((e) => e.id)).toEqual([3, 2, 1]);
  });

  it('is empty for an empty Timeline', () => {
    expect(timelineEntries([])).toEqual([]);
  });
});

describe('formatRelative', () => {
  const now = 10 * 24 * 3600 * 1000;
  it('speaks in minutes, hours and days', () => {
    expect(formatRelative(now - 5_000, now)).toBe('hace un momento');
    expect(formatRelative(now + 5_000, now)).toBe('hace un momento');
    expect(formatRelative(now - 2 * 60_000, now)).toBe('hace 2 min');
    expect(formatRelative(now - 3 * 3600_000, now)).toBe('hace 3 h');
    expect(formatRelative(now - 4 * 24 * 3600_000, now)).toBe('hace 4 d');
  });
});
