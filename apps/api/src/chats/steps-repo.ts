import type { Db } from '../db/index.js';

/** Runs a step of the panel (no AI) and leaves its interval behind; the step's own result passes through. */
export type StepRunner = <T>(kind: string, fn: () => Promise<T>) => Promise<T>;

export interface PanelStep {
  id: number;
  chatId: number;
  kind: string;
  startedAt: number;
  endedAt: number | null;
  result: string | null;
}

interface StepRow {
  id: number;
  chat_id: number;
  kind: string;
  started_at: number;
  ended_at: number | null;
  result: string | null;
}

function toStep(row: StepRow): PanelStep {
  return {
    id: row.id,
    chatId: row.chat_id,
    kind: row.kind,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    result: row.result,
  };
}

/** Interval of a step that ran before its chat existed; `record` stores it once the chat does. */
export interface PendingStep {
  kind: string;
  startedAt: number;
  endedAt: number;
  result: string;
}

/**
 * Wraps `fn` so its interval is measured: `onDone` gets the interval when `fn` ends, also when it throws.
 * The only place a step is timed; the repository's `timeStep` and the deferred runner both use it.
 */
async function measure<T>(
  now: () => number,
  fn: () => Promise<T>,
  onStart: (startedAt: number) => void,
  onDone: (endedAt: number, result: string) => void,
): Promise<T> {
  onStart(now());
  try {
    const value = await fn();
    onDone(now(), 'ok');
    return value;
  } catch (error) {
    onDone(now(), 'failed');
    throw error;
  }
}

export class PanelStepRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Opens the interval, runs the step and closes it even if it fails (the error is rethrown). */
  async timeStep<T>(chatId: number, kind: string, fn: () => Promise<T>): Promise<T> {
    let id = 0;
    return measure(
      this.now,
      fn,
      (startedAt) => {
        const result = this.db
          .prepare('INSERT INTO panel_steps (chat_id, kind, started_at) VALUES (?, ?, ?)')
          .run(chatId, kind, startedAt);
        id = Number(result.lastInsertRowid);
      },
      (endedAt, result) => {
        this.db
          .prepare('UPDATE panel_steps SET ended_at = ?, result = ? WHERE id = ?')
          .run(endedAt, result, id);
      },
    );
  }

  /** Runner bound to a chat, the shape the instrumented code receives. */
  runnerFor(chatId: number): StepRunner {
    return (kind, fn) => this.timeStep(chatId, kind, fn);
  }

  /**
   * Runner for steps that happen before the chat exists (the worktree setup): intervals are kept in
   * memory and `flush` writes them under the chat once it is created.
   */
  deferred(): { run: StepRunner; flush: (chatId: number) => void } {
    const pending: PendingStep[] = [];
    return {
      run: (kind, fn) => {
        let startedAt = 0;
        return measure(
          this.now,
          fn,
          (at) => {
            startedAt = at;
          },
          (endedAt, result) => pending.push({ kind, startedAt, endedAt, result }),
        );
      },
      flush: (chatId) => {
        for (const step of pending.splice(0)) this.record(chatId, step);
      },
    };
  }

  record(chatId: number, step: PendingStep): void {
    this.db
      .prepare(
        'INSERT INTO panel_steps (chat_id, kind, started_at, ended_at, result) VALUES (?, ?, ?, ?, ?)',
      )
      .run(chatId, step.kind, step.startedAt, step.endedAt, step.result);
  }

  /** Closes every step still open: at startup nothing of the previous process is running. */
  closeOpen(result: string): void {
    this.db
      .prepare('UPDATE panel_steps SET ended_at = ?, result = ? WHERE ended_at IS NULL')
      .run(this.now(), result);
  }

  listByChat(chatId: number): PanelStep[] {
    return (
      this.db
        .prepare('SELECT * FROM panel_steps WHERE chat_id = ? ORDER BY id')
        .all(chatId) as unknown as StepRow[]
    ).map(toStep);
  }
}
