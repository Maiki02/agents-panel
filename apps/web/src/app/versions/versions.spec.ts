import { describe, expect, it } from 'vitest';
import { historyPage, mergeTop } from './run-history';
import { behindLabel, deployPhase, isNewer, latestLabel, runDate, runRange } from './version-label';

describe('latestLabel', () => {
  it('says unknown when there is no latest (no network)', () => {
    expect(latestLabel('6.1.0', null)).toBe('última: desconocida');
    expect(latestLabel(null, null)).toBe('última: desconocida');
  });

  it('says up to date when installed equals or exceeds latest', () => {
    expect(latestLabel('6.1.0', '6.1.0')).toBe('última: 6.1.0 (al día)');
    expect(latestLabel('6.2.0', '6.1.0')).toBe('última: 6.1.0 (al día)');
  });

  it('flags a newer published version', () => {
    expect(latestLabel('6.1.0', '6.2.0')).toBe('última: 6.2.0 (hay una nueva)');
    expect(latestLabel('6.9.0', '6.10.0')).toBe('última: 6.10.0 (hay una nueva)');
  });
});

describe('isNewer / runRange', () => {
  it('compares numerically', () => {
    expect(isNewer('6.10.0', '6.9.0')).toBe(true);
    expect(isNewer('6.1.0', '6.1.0')).toBe(false);
  });

  it('shows the range without the kind, unknown versions as ?', () => {
    expect(runRange({ fromVersion: '6.0.0', toVersion: null })).toBe('6.0.0 → ?');
    expect(runRange({ fromVersion: 'aaa1111', toVersion: 'bbb2222' })).toBe('aaa1111 → bbb2222');
  });
});

describe('runDate', () => {
  it('reads like «31 oct 2026, 14:52», in 24 h and without the dot of the month', () => {
    expect(runDate(new Date(2026, 9, 31, 14, 52).getTime())).toBe('31 oct 2026, 14:52');
    expect(runDate(new Date(2026, 0, 5, 9, 3).getTime())).toBe('5 ene 2026, 09:03');
  });
});

describe('historyPage', () => {
  const runs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: n - i }));

  it('shows a page and says whether there is more (it asks one extra)', () => {
    expect(historyPage(runs(11), 10)).toEqual({ shown: runs(11).slice(0, 10), more: true });
    expect(historyPage(runs(10), 10)).toEqual({ shown: runs(10), more: false });
    expect(historyPage(runs(3), 10)).toEqual({ shown: runs(3), more: false });
  });
});

describe('mergeTop', () => {
  const ids = (...list: number[]) => list.map((id) => ({ id }));

  it('puts a fresh first page on top and keeps the older rows already loaded', () => {
    // 25 loaded (ids 25..6, more below); a new run (26) arrived.
    const loaded = ids(...Array.from({ length: 20 }, (_, i) => 25 - i));
    const page = { shown: ids(...Array.from({ length: 10 }, (_, i) => 26 - i)), more: true };
    const merged = mergeTop(page, loaded, true);
    expect(merged.runs.map((r) => r.id)).toEqual(Array.from({ length: 21 }, (_, i) => 26 - i));
    expect(merged.more).toBe(true);
  });

  it('takes the page as is when it is the whole history', () => {
    expect(mergeTop({ shown: ids(3, 2, 1), more: false }, ids(2, 1), false)).toEqual({
      runs: ids(3, 2, 1),
      more: false,
    });
    expect(mergeTop({ shown: ids(11, 10), more: true }, [], false)).toEqual({
      runs: ids(11, 10),
      more: true,
    });
  });
});

describe('behindLabel', () => {
  it('counts the commits of main not deployed yet', () => {
    expect(behindLabel(null)).toBe('commits sin desplegar: desconocido');
    expect(behindLabel(0)).toBe('al día con main');
    expect(behindLabel(1)).toBe('1 commit sin desplegar');
    expect(behindLabel(4)).toBe('4 commits sin desplegar');
  });
});

describe('deployPhase', () => {
  const panel = (commit: string, deployRunning = false) => ({ commit, deployRunning });

  it('is running while the script runs', () => {
    expect(deployPhase('aaa', panel('aaa', true), { status: 'running', output: null })).toBe(
      'running',
    );
  });

  it('waits for the restart when the run built a new commit or the server does not answer', () => {
    expect(
      deployPhase('aaa', panel('aaa'), {
        status: 'ok',
        output: 'DEPLOY_TO=bbb\nDEPLOY_RESTART=yes\n',
      }),
    ).toBe('restarting');
    expect(deployPhase('aaa', null, undefined)).toBe('restarting');
  });

  it('is done once the server runs another commit', () => {
    expect(deployPhase('aaa', panel('bbb'), undefined)).toBe('done');
  });

  it('finishes without a restart when main was up to date or the deploy failed', () => {
    expect(deployPhase('aaa', panel('aaa'), { status: 'ok', output: 'DEPLOY_RESTART=no\n' })).toBe(
      'finished',
    );
    // A run that found the disk already on another commit but did not restart is not waited on.
    expect(
      deployPhase('aaa', panel('aaa'), {
        status: 'ok',
        output: 'DEPLOY_TO=bbb\nDEPLOY_RESTART=no\n',
      }),
    ).toBe('finished');
    expect(deployPhase('aaa', panel('aaa'), { status: 'error', output: 'ERROR\n' })).toBe(
      'finished',
    );
  });
});
