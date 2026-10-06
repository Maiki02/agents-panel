import { describe, expect, it } from 'vitest';
import {
  AUTOPILOT_STATUSES,
  type AutopilotRun,
  type AutopilotStatus,
  type ChatKind,
} from '@agents-panel/shared';
import { pilotControls, pilotStatus } from './autopilot-logic';

function run(status: AutopilotStatus, over: Partial<AutopilotRun> = {}): AutopilotRun {
  return {
    chatId: 1,
    status,
    step: null,
    sprintN: null,
    sessionsInSprint: 0,
    lastFingerprint: null,
    stopReason: null,
    retryAt: null,
    policyVersion: null,
    seedPath: null,
    phase: null,
    prUrls: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const enabled = (
  kind: ChatKind,
  r: AutopilotRun | null,
  state?: Parameters<typeof pilotControls>[0]['workState'],
) =>
  Object.entries(pilotControls({ kind, run: r, workState: state }))
    .filter(([, v]) => !v.disabled)
    .map(([k]) => k)
    .sort();

describe('pilotControls', () => {
  it('a direct request and an idea have no enabled action, each with its reason', () => {
    for (const kind of ['direct', 'idea'] as const) {
      const controls = pilotControls({ kind, run: null });
      for (const action of Object.values(controls)) {
        expect(action.disabled).toBe(true);
        expect(action.reason).not.toBeNull();
      }
    }
    expect(pilotControls({ kind: 'idea', run: null }).on.reason).toContain('aprueba');
  });

  it.each(['scope', 'work'] as const)('a %s goes through every status of the run', (kind) => {
    expect(enabled(kind, null)).toEqual(['on']);
    expect(enabled(kind, run('off'))).toEqual(['on']);
    expect(enabled(kind, run('active'))).toEqual(['off', 'pause']);
    expect(enabled(kind, run('queued'))).toEqual(['off', 'pause']);
    expect(enabled(kind, run('waiting_quota'))).toEqual(['off', 'pause']);
    expect(enabled(kind, run('paused'))).toEqual(['off', 'resume']);
    expect(enabled(kind, run('stopped'))).toEqual(['off', 'resume']);
    expect(enabled(kind, run('finished'))).toEqual([]);
  });

  it('every disabled action explains itself, in every status', () => {
    for (const status of AUTOPILOT_STATUSES) {
      for (const action of Object.values(pilotControls({ kind: 'scope', run: run(status) }))) {
        expect(action.disabled).toBe(action.reason !== null);
      }
    }
  });

  it('turning on is refused once the PR is ready', () => {
    const merged = run('off', { phase: 'merge' });
    expect(enabled('work', merged, 'pr_lista')).toEqual([]);
    expect(pilotControls({ kind: 'work', run: merged, workState: 'pr_lista' }).on.reason).toContain(
      'PR',
    );
    expect(enabled('work', merged, 'abriendo_pr')).toEqual(['on']);
  });
});

describe('pilotStatus', () => {
  it('says off when there is no run', () => {
    expect(pilotStatus(null, 6)).toMatchObject({ label: 'Piloto apagado', sessions: null });
  });

  it('is amber when the user has to move and shows the sessions of the sprint', () => {
    expect(pilotStatus(run('paused'), 6).tone).toBe('warn');
    expect(pilotStatus(run('active'), 6).tone).toBe('accent');
    expect(pilotStatus(run('active', { sessionsInSprint: 2 }), 6).sessions).toBe(
      'Sesiones del sprint 2/6',
    );
    expect(pilotStatus(run('active'), 6).sessions).toBeNull();
    expect(pilotStatus(run('off', { sessionsInSprint: 2 }), 6).sessions).toBeNull();
  });

  it('shows the reason only for a stopped pilot', () => {
    expect(pilotStatus(run('stopped', { stopReason: 'Sin avance' }), 6)).toMatchObject({
      tone: 'warn',
      stopReason: 'Sin avance',
    });
    expect(pilotStatus(run('active', { stopReason: 'viejo' }), 6).stopReason).toBeNull();
  });
});
