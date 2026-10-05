import { describe, expect, it } from 'vitest';
import { WORKTREE_STATE_IDS } from '@agents-panel/shared';
import { workStateBadge } from './work-state';

describe('workStateBadge', () => {
  it('has a Spanish label and a tone for every state of the catalog', () => {
    for (const state of WORKTREE_STATE_IDS) {
      const badge = workStateBadge(state);
      expect(badge.label, state).not.toBe('');
      expect(badge.label, state).not.toContain('_');
      expect(['neutral', 'accent', 'ok', 'warn', 'danger'], state).toContain(badge.tone);
    }
  });

  it('is amber when it is the user who has to move, accent while the agent works', () => {
    expect(workStateBadge('madurando_idea').tone).toBe('accent');
    expect(workStateBadge('esperando_aprobacion_plan').tone).toBe('warn');
    expect(workStateBadge('esperando_aprobacion_cierre').tone).toBe('warn');
    expect(workStateBadge('esperando_respuesta').tone).toBe('warn');
    expect(workStateBadge('bloqueado').tone).toBe('warn');
    expect(workStateBadge('error').tone).toBe('danger');
    expect(workStateBadge('pr_lista').tone).toBe('ok');
    expect(workStateBadge('en_cola').tone).toBe('neutral');
  });
});
