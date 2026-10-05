import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import {
  blockerLabel,
  deleteBlockers,
  kyroBranchSummary,
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
