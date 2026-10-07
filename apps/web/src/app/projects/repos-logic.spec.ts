import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import type { ProjectRepo, RepoPullResult } from '@agents-panel/shared';
import { canSaveBase, mergeRepoRows, pullFailureOf, pullRowView, repoTitle } from './repos-logic';

const repo = (id: number, path: string, baseBranch = 'main'): ProjectRepo => ({
  id,
  projectId: 1,
  path,
  baseBranch,
});

const pullOk = (path: string, commits: number, ahead = 0, baseBranch = 'main'): RepoPullResult => ({
  path,
  baseBranch,
  error: null,
  result: {
    status: commits > 0 ? 'updated' : 'up_to_date',
    before: 'a',
    after: 'b',
    commits,
    ahead,
    output: '',
  },
});

const pullFail = (path: string, error: string): RepoPullResult => ({
  path,
  baseBranch: 'main',
  result: null,
  error,
});

describe('pullRowView', () => {
  it('says updated with the commits that came', () => {
    expect(pullRowView(pullOk('.', 1))).toMatchObject({
      state: 'updated',
      tone: 'ok',
      detail: '1 commit traído',
    });
    expect(pullRowView(pullOk('.', 3)).detail).toBe('3 commits traídos');
  });

  it('says up to date, and notes local commits GitHub does not have', () => {
    expect(pullRowView(pullOk('.', 0))).toMatchObject({
      state: 'up_to_date',
      label: 'Sin cambios',
    });
    expect(pullRowView(pullOk('.', 0, 2)).detail).toContain('2 commit(s) locales');
  });

  it('marks a rejected repo with its reason', () => {
    expect(pullRowView(pullFail('be', 'El clon tiene cambios locales'))).toMatchObject({
      state: 'rejected',
      tone: 'danger',
      detail: 'El clon tiene cambios locales',
    });
  });
});

describe('mergeRepoRows', () => {
  const repos = [repo(1, '.'), repo(2, 'be', 'dev')];

  it('puts each pull result in the row of its repo', () => {
    const rows = mergeRepoRows(repos, [pullOk('.', 1), pullFail('be', 'divergió')]);
    expect(rows.map((r) => [r.repo.path, r.pull?.state])).toEqual([
      ['.', 'updated'],
      ['be', 'rejected'],
    ]);
  });

  it('shows no result before any pull, or for a repo the pull did not reach', () => {
    expect(mergeRepoRows(repos, null).map((r) => r.pull)).toEqual([null, null]);
    expect(mergeRepoRows(repos, [pullOk('.', 0)]).map((r) => r.pull?.state ?? null)).toEqual([
      'up_to_date',
      null,
    ]);
  });

  it('ignores a result for a path that is not in the list', () => {
    expect(mergeRepoRows([repo(1, '.')], [pullOk('nuevo', 1)]).map((r) => r.pull)).toEqual([null]);
  });
});

describe('pullFailureOf', () => {
  it('keeps every repo row when the root fails with 409', () => {
    const failure = pullFailureOf(
      new HttpErrorResponse({
        status: 409,
        error: {
          error: 'El clon tiene cambios locales',
          repos: [pullFail('.', 'El clon tiene cambios locales'), pullOk('be', 2)],
        },
      }),
    );
    expect(failure?.error).toBe('El clon tiene cambios locales');
    expect(failure?.repos.map((r) => r.path)).toEqual(['.', 'be']);
    const rows = mergeRepoRows([repo(1, '.'), repo(2, 'be')], failure?.repos ?? null);
    expect(rows.map((r) => r.pull?.state)).toEqual(['rejected', 'updated']);
  });

  it('works for an error without rows (a project that is not ready) and ignores non-HTTP errors', () => {
    const failure = pullFailureOf(
      new HttpErrorResponse({ status: 409, error: { error: 'El proyecto todavía no está listo' } }),
    );
    expect(failure).toEqual({ repos: [], error: 'El proyecto todavía no está listo' });
    expect(pullFailureOf(new Error('x'))).toBeNull();
  });
});

describe('base branch edit', () => {
  it('can be saved only when it is not empty and changed', () => {
    expect(canSaveBase('main', 'dev')).toBe(true);
    expect(canSaveBase('main', ' dev ')).toBe(true);
    expect(canSaveBase('main', 'main')).toBe(false);
    expect(canSaveBase('main', '   ')).toBe(false);
    expect(canSaveBase('main', 'x'.repeat(201))).toBe(false);
  });

  it('names the root', () => {
    expect(repoTitle('.')).toBe('Raíz');
    expect(repoTitle('fe-ventas')).toBe('fe-ventas');
  });
});
