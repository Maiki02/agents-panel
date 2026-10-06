import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import {
  blockerLabel,
  deleteBlockers,
  kyroBranchSummary,
  kyroInitView,
  nameMatches,
  pullSummary,
} from './repo-actions';

const result = { before: 'a', after: 'b', output: '' };

describe('pullSummary', () => {
  it('says it is up to date, mentioning local commits GitHub lacks', () => {
    expect(pullSummary({ ...result, status: 'up_to_date', commits: 0, ahead: 0 })).toBe(
      'Ya está al día con GitHub.',
    );
    expect(pullSummary({ ...result, status: 'up_to_date', commits: 0, ahead: 2 })).toContain(
      '2 commit(s) locales',
    );
  });

  it('counts the commits brought', () => {
    expect(pullSummary({ ...result, status: 'updated', commits: 1, ahead: 0 })).toBe(
      'Se trajeron 1 commit de GitHub.',
    );
    expect(pullSummary({ ...result, status: 'updated', commits: 3, ahead: 0 })).toBe(
      'Se trajeron 3 commits de GitHub.',
    );
  });
});

describe('pullSummary with repos', () => {
  it('names the repos that were rejected', () => {
    const text = pullSummary({
      ...result,
      status: 'updated',
      commits: 1,
      ahead: 0,
      repos: [
        { path: '.', baseBranch: 'main', result: null, error: null },
        { path: 'be', baseBranch: 'dev', result: null, error: 'El clon tiene cambios locales' },
      ],
    });
    expect(text).toBe('Se trajeron 1 commit de GitHub. be: El clon tiene cambios locales.');
  });
});

describe('kyroBranchSummary', () => {
  it('names the branch and tells the user it still has to be merged', () => {
    const text = kyroBranchSummary(
      { branch: 'chore/kyro-init', path: '/wt/p/kyro-init', commit: 'abc' },
      'dev',
    );
    expect(text).toContain('chore/kyro-init');
    expect(text).toContain('mergeala a dev');
  });
});

describe('kyroInitView', () => {
  const base = { status: 'ready', baseBranch: 'main' } as const;
  const pending = {
    branch: 'chore/kyro-init',
    pushed: false,
    prUrl: 'https://github.com/o/r/pull/new/chore/kyro-init',
  };

  it('lets a project without Kyro and without a branch start the init', () => {
    expect(kyroInitView({ ...base, hasKyro: false, kyroInit: null })).toMatchObject({
      state: 'none',
      canInit: true,
      initReason: null,
      chip: null,
    });
    expect(kyroInitView({ ...base, status: 'cloning', hasKyro: false })).toMatchObject({
      canInit: false,
    });
  });

  it('shows a pending chip, disables the init and offers the push while the branch is local', () => {
    const view = kyroInitView({ ...base, hasKyro: false, kyroInit: pending });
    expect(view).toMatchObject({
      state: 'pending',
      chip: 'Pendiente de subir y mergear',
      canInit: false,
      canPush: true,
      prUrl: pending.prUrl,
    });
    expect(view.initReason).toContain('chore/kyro-init');
    expect(view.steps).toHaveLength(3);
  });

  it('after the push only the merge and the pull are left', () => {
    for (const view of [
      kyroInitView({ ...base, hasKyro: false, kyroInit: { ...pending, pushed: true } }),
      kyroInitView({ ...base, hasKyro: false, kyroInit: pending }, true),
    ]) {
      expect(view).toMatchObject({ chip: 'Pendiente de merge', canPush: false, canInit: false });
      expect(view.steps).toHaveLength(2);
      expect(view.steps[0]).toContain('mergeala a main');
    }
  });

  it('has nothing pending once the project has Kyro', () => {
    expect(kyroInitView({ ...base, hasKyro: true, kyroInit: pending })).toMatchObject({
      state: 'has_kyro',
      chip: null,
      canPush: false,
    });
  });
});

describe('nameMatches', () => {
  it('requires the exact label, ignoring surrounding spaces', () => {
    expect(nameMatches('Mi Demo', ' Mi Demo ')).toBe(true);
    expect(nameMatches('Mi Demo', 'mi demo')).toBe(false);
    expect(nameMatches('Mi Demo', '')).toBe(false);
  });
});

describe('deleteBlockers', () => {
  const http = (status: number, error: unknown) => new HttpErrorResponse({ status, error });

  it('reads the blockers of a 409', () => {
    const blockers = [
      { path: '/wt/a', kind: 'unpushed', detail: 'rama x: 1 commit(s) sin pushear' },
    ];
    expect(deleteBlockers(http(409, { error: 'x', blockers }))).toEqual(blockers);
    expect(blockerLabel(blockers[0] as never)).toBe('Sin pushear');
  });

  it('ignores other statuses, malformed items and non-http errors', () => {
    expect(deleteBlockers(http(500, { blockers: [] }))).toEqual([]);
    expect(deleteBlockers(http(409, { error: 'x' }))).toEqual([]);
    expect(deleteBlockers(http(409, { blockers: [{ path: 1 }, null, 'x'] }))).toEqual([]);
    expect(deleteBlockers(new Error('boom'))).toEqual([]);
  });
});
