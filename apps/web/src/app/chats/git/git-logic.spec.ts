import { describe, expect, it } from 'vitest';
import { PARITY_CATALOG } from '@agents-panel/shared';
import {
  PARITY_BUTTONS,
  commitWarning,
  conflictMessage,
  deleteRisks,
  diffFileLabel,
  diffFileSummary,
  discardQuestion,
  fileStatusLabel,
  gitBlockedReason,
  outcomesOf,
  patchLineClass,
  prOutcomeText,
  repoSummary,
  repoTitle,
  stepButtons,
} from './git-logic';

describe('commitWarning', () => {
  it('accepts Conventional Commits with and without scope or breaking mark', () => {
    for (const message of [
      'feat(web): pestaña Git',
      'fix: arreglo',
      'docs(vm)!: cambio',
      'chore(api): x\n\ncuerpo libre',
    ]) {
      expect(commitWarning(message)).toBeNull();
    }
  });

  it('warns, without blocking, for any other message', () => {
    for (const message of ['arreglo cosas', 'Feat: x', 'feat:sin espacio', 'feat(): x']) {
      expect(commitWarning(message)).toMatch(/Conventional Commits/);
    }
  });

  it('does not warn on an empty message (the commit button is what stays disabled)', () => {
    expect(commitWarning('   ')).toBeNull();
  });
});

describe('gitBlockedReason', () => {
  const free = { chatStatus: 'idle', workState: null, pilotStatus: null } as const;

  it('is null when nothing is working', () => {
    expect(gitBlockedReason(free)).toBeNull();
    expect(gitBlockedReason({ ...free, pilotStatus: 'paused' })).toBeNull();
    expect(gitBlockedReason({ ...free, pilotStatus: 'off' })).toBeNull();
  });

  it('explains a running agent', () => {
    expect(gitBlockedReason({ ...free, chatStatus: 'running' })).toMatch(/agente/);
  });

  it('explains a busy pilot: active, queued and waiting_quota', () => {
    for (const pilotStatus of ['active', 'queued', 'waiting_quota'] as const) {
      expect(gitBlockedReason({ ...free, pilotStatus })).toContain(pilotStatus);
    }
  });

  it('explains an archived work first, whatever else is going on', () => {
    expect(
      gitBlockedReason({ chatStatus: 'running', workState: 'archivado', pilotStatus: 'active' }),
    ).toMatch(/archivado/);
  });
});

describe('repo texts', () => {
  it('names the root and shows counts, leaving out the unknown ones', () => {
    expect(repoTitle('.')).toBe('Raíz');
    expect(repoTitle('fe-ventas')).toBe('fe-ventas');
    expect(repoSummary({ files: [], ahead: 0, behind: 0 })).toBe(
      'sin cambios · 0 adelante · 0 atrás',
    );
    expect(repoSummary({ files: [{ path: 'a', status: 'M' }], ahead: null, behind: null })).toBe(
      '1 archivo cambiado',
    );
    expect(
      repoSummary({
        files: [
          { path: 'a', status: 'M' },
          { path: 'b', status: '??' },
        ],
        ahead: 2,
        behind: 1,
      }),
    ).toBe('2 archivos cambiados · 2 adelante · 1 atrás');
  });

  it('labels porcelain codes', () => {
    expect(fileStatusLabel('??')).toBe('nuevo');
    expect(fileStatusLabel(' M')).toBe('modificado');
    expect(fileStatusLabel('UU')).toBe('conflicto');
    expect(fileStatusLabel(' D')).toBe('borrado');
  });
});

describe('parity catalog (D26): every manual action has a button', () => {
  it('maps each action with a manual access to a button of the web', () => {
    for (const action of PARITY_CATALOG) {
      if (action.manual === null) {
        // repair_kyro: manual and without a route yet, so no button either.
        expect(PARITY_BUTTONS[action.id], action.id).toBeUndefined();
      } else {
        expect(PARITY_BUTTONS[action.id], action.id).toBeDefined();
      }
    }
  });

  it('every step of the catalog is a button of a scope, or lives in the PR dialog', () => {
    const inPrDialog = new Set(['merge_dev']);
    const offered = new Set(stepButtons('scope', false).map((b) => b.step));
    for (const action of PARITY_CATALOG) {
      if (action.manual?.type !== 'step') continue;
      const step = action.manual.step;
      if (inPrDialog.has(step)) {
        expect(stepButtons('scope', true).map((b) => b.step)).toContain(step);
      } else {
        expect(offered.has(step), step).toBe(true);
      }
    }
  });

  it('offers steps only where they apply', () => {
    expect(stepButtons('direct', true)).toEqual([]);
    expect(stepButtons('idea', true)).toEqual([]);
    expect(stepButtons('work', false).map((b) => b.step)).not.toContain('qa');
    expect(stepButtons('scope', false).map((b) => b.step)).toEqual([
      'plan',
      'execute',
      'qa',
      'fix',
      'close',
      'complete',
    ]);
    expect(stepButtons('scope', false).map((b) => b.step)).not.toContain('merge_dev');
    expect(stepButtons('scope', true).map((b) => b.step)).toContain('merge_dev');
  });
});

describe('diff, discard, delete and PR texts', () => {
  it('labels diff files and colors patch lines', () => {
    expect(diffFileLabel({ status: 'modified', binary: true })).toBe('binario');
    expect(diffFileLabel({ status: 'untracked', binary: false })).toBe('nuevo');
    expect(diffFileSummary({ additions: 3, deletions: 1 })).toBe('+3 −1');
    expect(patchLineClass('+nuevo')).toBe('text-ok');
    expect(patchLineClass('-viejo')).toBe('text-danger');
    expect(patchLineClass('+++ b/a')).toBe('text-muted');
    expect(patchLineClass(' igual')).toBe('');
  });

  it('asks to discard with the number of files', () => {
    expect(discardQuestion(['a'])).toContain('1 archivo.');
    expect(discardQuestion(['a', 'b'])).toContain('2 archivos');
  });

  it('lists what deleting would lose, and nothing for a clean repo', () => {
    const repo = {
      path: '.',
      branch: 'feature/x',
      remoteExists: true,
      unpushedCommits: 2,
      uncommittedFiles: ['a.ts'],
      error: null,
    };
    expect(deleteRisks(repo)).toEqual(['2 commits sin pushear', '1 archivo sin commitear']);
    expect(deleteRisks({ ...repo, unpushedCommits: 0, uncommittedFiles: [] })).toEqual([]);
    expect(deleteRisks({ ...repo, unpushedCommits: 1, uncommittedFiles: [] })).toEqual([
      '1 commit sin pushear',
    ]);
  });

  it('says why a PR stopped, naming the files with secrets', () => {
    expect(
      prOutcomeText({ path: '.', result: 'error', output: 'x', secrets: ['.env', 'k.pem'] }),
    ).toContain('.env, k.pem');
    expect(prOutcomeText({ path: '.', result: 'ok', output: '', url: 'u' })).toBe('PR creada');
    expect(
      prOutcomeText({ path: '.', result: 'ok', output: '', url: 'u', existing: true }),
    ).toMatch(/ya existía/);
    expect(prOutcomeText({ path: '.', result: 'error', output: 'sin gh' })).toBe('sin gh');
  });
});

describe('conflict hand-over and API answers', () => {
  it('writes a message with the repo and every file', () => {
    const text = conflictMessage('base', 'be-ventas', ['a.ts', 'b/c.ts']);
    expect(text).toContain('el repo be-ventas');
    expect(text).toContain('traer la rama base');
    expect(text).toContain('- a.ts\n- b/c.ts');
    expect(conflictMessage('branch', '.', ['x'])).toContain('la raíz del trabajo');
  });

  it('reads outcomes from a list answer or from a single outcome', () => {
    const one = { path: '.', result: 'ok', output: '' };
    expect(outcomesOf({ repos: [one] })).toEqual([one]);
    expect(outcomesOf(one)).toEqual([one]);
    expect(outcomesOf(null)).toEqual([]);
    expect(outcomesOf({ error: 'x' })).toEqual([]);
  });
});
