import type {
  AutopilotPhase,
  AutopilotRun,
  AutopilotStatus,
  AutopilotStep,
} from '@agents-panel/shared';
import type { Db } from '../db/index.js';
import { completedTask } from './decide.js';

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
  seed_path: string | null;
  phase: AutopilotPhase | null;
  pr_urls: string;
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

function parseUrls(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
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
    seedPath: row.seed_path,
    phase: row.phase,
    prUrls: parseUrls(row.pr_urls),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The action does not apply to the status the autopilot is in (the API answers 409). */
export class AutopilotTransitionError extends Error {
  override readonly name = 'AutopilotTransitionError';
}

type Action =
  'pause' | 'resume' | 'off' | 'stop' | 'finish' | 'queue' | 'dequeue' | 'quota' | 'retry';

/** Statuses from which each explicit transition is allowed. Anything else is refused. */
const FROM: Record<Action, readonly AutopilotStatus[]> = {
  // Pausing never cuts a running turn: the pilot just does not open the next step.
  pause: ['active', 'queued', 'waiting_quota'],
  // A stopped work resumes once the user fixed what stopped it; `off` is switched back on.
  resume: ['paused', 'stopped', 'off'],
  off: ['active', 'paused', 'stopped', 'waiting_quota', 'queued'],
  stop: ['active', 'queued', 'waiting_quota'],
  finish: ['active'],
  // No free session: wait in line until one frees up.
  queue: ['active'],
  dequeue: ['queued'],
  // Usage limit reached: wait and try again later.
  quota: ['active', 'queued'],
  retry: ['waiting_quota'],
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

  /** A resumed step counts as one more session of the sprint (the restart cap depends on it). */
  countSession(chatId: number): AutopilotRun {
    this.require(chatId);
    this.db
      .prepare(
        'UPDATE autopilot_runs SET sessions_in_sprint = sessions_in_sprint + 1, updated_at = ? WHERE chat_id = ?',
      )
      .run(this.now(), chatId);
    return this.require(chatId);
  }

  /** Moves the run to a phase (null clears it); a restart takes the phase up again. */
  setPhase(chatId: number, phase: AutopilotPhase | null): AutopilotRun {
    this.require(chatId);
    this.db
      .prepare('UPDATE autopilot_runs SET phase = ?, updated_at = ? WHERE chat_id = ?')
      .run(phase, this.now(), chatId);
    return this.require(chatId);
  }

  /** Remembers the PRs of the work (replaces the list; the merge phase re-reads them from GitHub). */
  setPrUrls(chatId: number, urls: readonly string[]): AutopilotRun {
    this.require(chatId);
    this.db
      .prepare('UPDATE autopilot_runs SET pr_urls = ?, updated_at = ? WHERE chat_id = ?')
      .run(JSON.stringify([...new Set(urls)]), this.now(), chatId);
    return this.require(chatId);
  }

  /** Runs in a status, oldest first (the pilot lists the queued ones when a session frees up). */
  listByStatus(status: AutopilotStatus): AutopilotRun[] {
    return (
      this.db
        .prepare('SELECT * FROM autopilot_runs WHERE status = ? ORDER BY updated_at, chat_id')
        .all(status) as unknown as RunRow[]
    ).map(toRun);
  }

  /**
   * Switches the autopilot on for a chat that has none. `seedPath` is the idea document of an
   * approved scope: the pilot creates the scope from it before anything else.
   */
  create(
    chatId: number,
    policyVersion: number | null = null,
    seedPath: string | null = null,
  ): AutopilotRun {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO autopilot_runs (chat_id, status, policy_version, seed_path, created_at, updated_at)
         VALUES (?, 'active', ?, ?, ?, ?)`,
      )
      .run(chatId, policyVersion, seedPath, now, now);
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

  /** Waits in line for a free session; the pilot tries again when one frees up. */
  queue(chatId: number): AutopilotRun {
    return this.move(chatId, 'queue', 'queued', {});
  }

  dequeue(chatId: number): AutopilotRun {
    return this.move(chatId, 'dequeue', 'active', {});
  }

  /** The usage limit was reached: waits until `retryAt` (epoch ms) and tries again. */
  waitForQuota(chatId: number, retryAt: number): AutopilotRun {
    return this.move(chatId, 'quota', 'waiting_quota', { retry_at: retryAt });
  }

  retryAfterQuota(chatId: number): AutopilotRun {
    return this.move(chatId, 'retry', 'active', { retry_at: null });
  }

  /**
   * A session is about to open: records its step, the signals Kyro showed before it (to tell later
   * whether it moved anything) and counts it for the sprint; a new sprint restarts the count.
   */
  beginSession(
    chatId: number,
    input: {
      step: AutopilotStep;
      sprintN: number | null;
      fingerprint: Record<string, unknown>;
      policyVersion: number;
    },
  ): AutopilotRun {
    const run = this.require(chatId);
    // A planning step opens the count of the next sprint.
    // The cap counts sessions in a row that closed no task: an execution that did restarts it.
    const newSprint =
      input.step === 'plan' ||
      (input.sprintN !== null && input.sprintN !== run.sprintN) ||
      completedTask(run.step, run.lastFingerprint, input.fingerprint);
    this.db
      .prepare(
        `UPDATE autopilot_runs SET step = ?, sprint_n = ?, sessions_in_sprint = ?, last_fingerprint = ?,
           policy_version = ?, updated_at = ? WHERE chat_id = ?`,
      )
      .run(
        input.step,
        input.sprintN ?? run.sprintN,
        newSprint ? 1 : run.sessionsInSprint + 1,
        JSON.stringify(input.fingerprint),
        input.policyVersion,
        this.now(),
        chatId,
      );
    return this.require(chatId);
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
