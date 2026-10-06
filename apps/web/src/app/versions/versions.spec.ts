import { describe, expect, it } from 'vitest';
import { behindLabel, deployPhase, isNewer, latestLabel, runLabel } from './version-label';

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

describe('isNewer / runLabel', () => {
  it('compares numerically', () => {
    expect(isNewer('6.10.0', '6.9.0')).toBe(true);
    expect(isNewer('6.1.0', '6.1.0')).toBe(false);
  });

  it('shows unknown versions as ?', () => {
    expect(runLabel({ kind: 'kyro-update', fromVersion: '6.0.0', toVersion: null })).toBe(
      'Kyro 6.0.0 → ?',
    );
    expect(runLabel({ kind: 'panel-deploy', fromVersion: 'aaa1111', toVersion: 'bbb2222' })).toBe(
      'Panel aaa1111 → bbb2222',
    );
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
