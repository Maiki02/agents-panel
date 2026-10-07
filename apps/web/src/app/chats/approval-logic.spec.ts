import { describe, expect, it } from 'vitest';
import type { WorktreeTransition } from '@agents-panel/shared';
import {
  approvalCard,
  debtActionState,
  debtFromTimeline,
  ideaActionStates,
  parseInline,
  parseMarkdown,
  prLinks,
  showPrCard,
} from './approval-logic';

describe('approvalCard', () => {
  it('shows the plan card for an idea waiting for approval and nothing for other kinds', () => {
    expect(approvalCard('idea', 'esperando_aprobacion_plan')).toBe('idea');
    expect(approvalCard('scope', 'esperando_aprobacion_plan')).toBeNull();
    expect(approvalCard('work', 'esperando_aprobacion_plan')).toBeNull();
  });

  it('shows the debt card for a scope waiting for the closing approval', () => {
    expect(approvalCard('scope', 'esperando_aprobacion_cierre')).toBe('debt');
    expect(approvalCard('work', 'esperando_aprobacion_cierre')).toBeNull();
    expect(approvalCard('idea', 'esperando_aprobacion_cierre')).toBeNull();
  });

  it('shows the PR links when the PR is ready, whatever the kind', () => {
    for (const kind of ['scope', 'work'] as const)
      expect(approvalCard(kind, 'pr_lista')).toBe('pr');
  });

  it('looks for the PR of a finished scope or work, never of an idea or a direct chat', () => {
    expect(approvalCard('work', 'terminado')).toBe('pr');
    expect(approvalCard('scope', 'terminado')).toBe('pr');
    expect(approvalCard('idea', 'terminado')).toBeNull();
    expect(approvalCard('direct', 'terminado')).toBeNull();
  });

  it('shows nothing in any other state, or without state', () => {
    expect(approvalCard('idea', 'madurando_idea')).toBeNull();
    expect(approvalCard('scope', 'planificando')).toBeNull();
    expect(approvalCard('scope', null)).toBeNull();
    expect(approvalCard('direct', undefined)).toBeNull();
  });
});

describe('showPrCard', () => {
  it('always shows the card when the PR is ready, and a finished work only with a link', () => {
    expect(showPrCard('pr_lista', [])).toBe(true);
    expect(showPrCard('terminado', ['https://github.com/a/b/pull/1'])).toBe(true);
    expect(showPrCard('terminado', [])).toBe(false);
  });
});

describe('ideaActionStates', () => {
  const ready = { path: '.agents/kyro/plan/a.md', documents: ['.agents/kyro/plan/a.md'] };

  it('enables both approvals with exactly one document, and asking for changes needs text', () => {
    const states = ideaActionStates({ document: ready, changes: '', busy: false });
    expect(states.approve_scope).toEqual({ disabled: false, reason: null });
    expect(states.approve_work.disabled).toBe(false);
    expect(states.request_changes).toEqual({
      disabled: true,
      reason: 'Escribí qué querés cambiar.',
    });
    expect(
      ideaActionStates({ document: ready, changes: '  ', busy: false }).request_changes.disabled,
    ).toBe(true);
    expect(
      ideaActionStates({ document: ready, changes: 'Falta X', busy: false }).request_changes,
    ).toEqual({ disabled: false, reason: null });
  });

  it('disables every action with the reason while a call runs', () => {
    const states = ideaActionStates({ document: ready, changes: 'x', busy: true });
    for (const state of Object.values(states)) {
      expect(state).toEqual({ disabled: true, reason: 'Enviando tu decisión…' });
    }
  });

  it('does not approve while the plan loads, with no document or with several', () => {
    expect(
      ideaActionStates({ document: null, changes: '', busy: false }).approve_work.reason,
    ).toMatch(/Cargando/);
    expect(
      ideaActionStates({ document: { path: null, documents: [] }, changes: '', busy: false })
        .approve_scope.reason,
    ).toMatch(/no hay un plan/);
    expect(
      ideaActionStates({
        document: { path: null, documents: ['a.md', 'b.md'] },
        changes: '',
        busy: false,
      }).approve_scope.reason,
    ).toMatch(/más de un documento/);
  });
});

describe('debtActionState', () => {
  it('cannot be sent without the reason, nor while it runs', () => {
    expect(debtActionState({ reason: '', busy: false }).disabled).toBe(true);
    expect(debtActionState({ reason: '   ', busy: false }).reason).toMatch(/por qué aceptás/);
    expect(debtActionState({ reason: 'Se hace en el sprint 5', busy: false })).toEqual({
      disabled: false,
      reason: null,
    });
    expect(debtActionState({ reason: 'ok', busy: true }).disabled).toBe(true);
  });
});

describe('debtFromTimeline', () => {
  const entry = (toState: WorktreeTransition['toState'], data: unknown): WorktreeTransition => ({
    id: 1,
    chatId: 1,
    fromState: null,
    toState,
    reason: null,
    actor: 'pilot',
    role: null,
    model: null,
    data,
    createdAt: 1,
  });

  it('reads the debt of the latest closing stop', () => {
    const debt = [{ id: 'debt-3', title: 'Algo', priority: 'high' }];
    expect(
      debtFromTimeline([
        entry('esperando_aprobacion_cierre', {
          debt: [{ id: 'debt-1', title: 'Viejo', priority: 'low' }],
        }),
        entry('planificando', null),
        entry('esperando_aprobacion_cierre', { debt }),
        entry('cerrando', null),
      ]),
    ).toEqual(debt);
  });

  it('is empty without a stop that carries debt', () => {
    expect(debtFromTimeline([])).toEqual([]);
    expect(debtFromTimeline([entry('esperando_aprobacion_cierre', { nextAction: 'x' })])).toEqual(
      [],
    );
  });
});

describe('prLinks', () => {
  it('keeps only https URLs', () => {
    expect(
      prLinks([
        'https://github.com/o/r/pull/1',
        'javascript:alert(1)',
        'http://x/y',
        'data:text/html,x',
      ]),
    ).toEqual(['https://github.com/o/r/pull/1']);
  });
});

describe('markdown without raw HTML', () => {
  it('shows a <script> of the document as text, never as markup', () => {
    const blocks = parseMarkdown(
      '# Plan\n\n<script>alert(1)</script>\n\nTexto <img src=x onerror=alert(1)>',
    );
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1 });
    expect(blocks[1]).toEqual({
      kind: 'paragraph',
      inline: [{ kind: 'text', text: '<script>alert(1)</script>' }],
    });
    expect(JSON.stringify(blocks)).toContain('<img src=x onerror=alert(1)>');
    // Every piece is plain data with a text field: there is no html field to bind.
    expect(JSON.stringify(blocks)).not.toContain('innerHTML');
  });

  it('parses headings, lists, code, quotes and rules', () => {
    const blocks = parseMarkdown(
      [
        '## Objetivo',
        'Una línea',
        'y otra',
        '',
        '- uno',
        '- dos',
        '',
        '1. a',
        '2. b',
        '',
        '```ts',
        'const x = 1;',
        '```',
        '> cita',
        '---',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      'heading',
      'paragraph',
      'list',
      'list',
      'code',
      'quote',
      'rule',
    ]);
    expect(blocks[1]).toEqual({
      kind: 'paragraph',
      inline: [{ kind: 'text', text: 'Una línea y otra' }],
    });
    expect(blocks[2]).toMatchObject({ kind: 'list', ordered: false });
    expect(blocks[3]).toMatchObject({ kind: 'list', ordered: true });
    expect(blocks[4]).toEqual({ kind: 'code', text: 'const x = 1;' });
  });

  it('keeps the text of a link and drops its URL, so no javascript: link exists', () => {
    expect(
      parseInline('ver [la doc](javascript:alert(1)) y `código` **fuerte** *énfasis*'),
    ).toEqual([
      { kind: 'text', text: 'ver ' },
      { kind: 'text', text: 'la doc' },
      { kind: 'text', text: ' y ' },
      { kind: 'code', text: 'código' },
      { kind: 'text', text: ' ' },
      { kind: 'strong', text: 'fuerte' },
      { kind: 'text', text: ' ' },
      { kind: 'em', text: 'énfasis' },
    ]);
  });
});
