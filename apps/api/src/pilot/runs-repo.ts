import type { AutopilotRun, AutopilotStatus, AutopilotStep } from '@agents-panel/shared';
import type { Db } from '../db/index.js';

interface RunRow {
  chat_id: number;
  status: AutopilotStatus;
  step: AutopilotStep | null;
  sprint_n: number | null;
  sessions_in_sprint: number;
  last_fingerprint: string | null;
  stop_reason: string | null;
  retry_at: number | null;
  policy_version: number | null;
  created_at: number;
  updated_at: number;
}

function parseFingerprint(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toRun(row: RunRow): AutopilotRun {
  return {
    chatId: row.chat_id,
    status: row.status,
    step: row.step,
    sprintN: row.sprint_n,
    sessionsInSprint: row.sessions_in_sprint,
    lastFingerprint: parseFingerprint(row.last_fingerprint),
    stopReason: row.stop_reason,
    retryAt: row.retry_at,
    policyVersion: row.policy_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The action does not apply to the status the autopilot is in (the API answers 409). */
export class AutopilotTransitionError extends Error {
  override readonly name = 'AutopilotTransitionError';
}

type Action = 'pause' | 'resume' | 'off' | 'stop' | 'finish';

/** Statuses from which each explicit transition is allowed. Anything else is refused. */
const FROM: Record<Action, readonly AutopilotStatus[]> = {
  // Pausing never cuts a running turn: the pilot just does not open the next step.
  pause: ['active', 'queued', 'waiting_quota'],
  // A stopped work resumes once the user fixed what stopped it; `off` is switched back on.
  resume: ['paused', 'stopped', 'off'],
  off: ['active', 'paused', 'stopped', 'waiting_quota', 'queued'],
  stop: ['active', 'queued', 'waiting_quota'],
  finish: ['active'],
};

/** One row per scope or work with the autopilot on; the pilot's state lives here, not in memory. */
export class AutopilotRunRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  get(chatId: number): AutopilotRun | undefined {
    const row = this.db.prepare('SELECT * FROM autopilot_runs WHERE chat_id = ?').get(chatId) as
      RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  /** Switches the autopilot on for a chat that has none. */
  create(chatId: number, policyVersion: number | null = null): AutopilotRun {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO autopilot_runs (chat_id, status, policy_version, created_at, updated_at)
         VALUES (?, 'active', ?, ?, ?)`,
      )
      .run(chatId, policyVersion, now, now);
    return this.require(chatId);
  }

  pause(chatId: number): AutopilotRun {
    return this.move(chatId, 'pause', 'paused', {});
  }

  /** Back to active; a stop or the previous session count no longer applies. */
  resume(chatId: number): AutopilotRun {
    return this.move(chatId, 'resume', 'active', {
      stop_reason: null,
      retry_at: null,
      sessions_in_sprint: 0,
    });
  }

  turnOff(chatId: number): AutopilotRun {
    return this.move(chatId, 'off', 'off', { stop_reason: null, retry_at: null });
  }

  /** The pilot stopped on purpose; the reason is always shown to the user. */
  stop(chatId: number, reason: string): AutopilotRun {
    if (reason.trim() === '') throw new AutopilotTransitionError('Un freno necesita un motivo');
    return this.move(chatId, 'stop', 'stopped', { stop_reason: reason });
  }

  finish(chatId: number): AutopilotRun {
    return this.move(chatId, 'finish', 'finished', { stop_reason: null, retry_at: null });
  }

  private require(chatId: number): AutopilotRun {
    const run = this.get(chatId);
    if (!run) throw new AutopilotTransitionError('El piloto no está activado en este trabajo');
    return run;
  }

  private move(
    chatId: number,
    action: Action,
    to: AutopilotStatus,
    extra: Record<string, string | number | null>,
  ): AutopilotRun {
    const run = this.require(chatId);
    if (!FROM[action].includes(run.status)) {
      throw new AutopilotTransitionError(`No se puede ${action} un piloto en estado ${run.status}`);
    }
    const columns = { status: to, ...extra, updated_at: this.now() };
    const assignments = Object.keys(columns)
      .map((column) => `${column} = ?`)
      .join(', ');
    this.db
      .prepare(`UPDATE autopilot_runs SET ${assignments} WHERE chat_id = ?`)
      .run(...Object.values(columns), chatId);
    return this.require(chatId);
  }
}
