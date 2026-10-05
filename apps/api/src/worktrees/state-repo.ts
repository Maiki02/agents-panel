import {
  ACTORS,
  BLOCKED_REASONS,
  WORKTREE_STATE_IDS,
  type Actor,
  type BlockedReason,
  type ModelRole,
  type WorktreeState,
  type WorktreeStateId,
  type WorktreeTransition,
} from '@agents-panel/shared';
import type { ChatEventBus } from '../chats/events.js';
import type { ChatRepository } from '../chats/repo.js';
import type { Db } from '../db/index.js';

interface StateRow {
  chat_id: number;
  state: WorktreeStateId;
  detail: string | null;
  phase: string | null;
  sprint_current: number | null;
  sprint_closed: number | null;
  sprint_total: number | null;
  task_done: number | null;
  task_total: number | null;
  open_debt: number | null;
  blocked_reason: BlockedReason | null;
  actor: Actor;
  role: ModelRole | null;
  model: string | null;
  since: number;
  previous_state: WorktreeStateId | null;
}

interface TransitionRow {
  id: number;
  chat_id: number;
  from_state: WorktreeStateId | null;
  to_state: WorktreeStateId;
  reason: string | null;
  actor: Actor;
  role: ModelRole | null;
  model: string | null;
  data: string | null;
  created_at: number;
}

function toState(row: StateRow): WorktreeState {
  return {
    chatId: row.chat_id,
    state: row.state,
    detail: row.detail,
    phase: row.phase,
    sprintCurrent: row.sprint_current,
    sprintClosed: row.sprint_closed,
    sprintTotal: row.sprint_total,
    taskDone: row.task_done,
    taskTotal: row.task_total,
    openDebt: row.open_debt,
    blockedReason: row.blocked_reason,
    actor: row.actor,
    role: row.role,
    model: row.model,
    since: row.since,
    previousState: row.previous_state,
  };
}

function toTransition(row: TransitionRow): WorktreeTransition {
  return {
    id: row.id,
    chatId: row.chat_id,
    fromState: row.from_state,
    toState: row.to_state,
    reason: row.reason,
    actor: row.actor,
    role: row.role,
    model: row.model,
    data: row.data === null ? null : (JSON.parse(row.data) as unknown),
    createdAt: row.created_at,
  };
}

export class InvalidStateError extends Error {
  override readonly name = 'InvalidStateError';
}

/** What a transition records. `state` and `actor` are mandatory: nobody changes state anonymously. */
export interface TransitionInput {
  state: WorktreeStateId;
  actor: Actor;
  reason?: string | null;
  detail?: string | null;
  phase?: string | null;
  sprintCurrent?: number | null;
  sprintClosed?: number | null;
  sprintTotal?: number | null;
  taskDone?: number | null;
  taskTotal?: number | null;
  openDebt?: number | null;
  blockedReason?: BlockedReason | null;
  role?: ModelRole | null;
  model?: string | null;
  /** Extra signals behind the transition (stored as JSON in the Timeline entry). */
  data?: unknown;
  /** Adds a Timeline entry even when the state repeats (a decision that must stay on record). */
  record?: boolean;
}

export interface TransitionResult {
  state: WorktreeState;
  /** False when only the detail or progress of the same state was updated. */
  changed: boolean;
}

/** The panel's source of truth for the fine state of a scope or work, plus its Timeline. */
export class WorktreeStateRepository {
  constructor(
    private readonly db: Db,
    private readonly chats: ChatRepository,
    private readonly bus: ChatEventBus,
    private readonly now: () => number = Date.now,
  ) {}

  get(chatId: number): WorktreeState | undefined {
    const row = this.db.prepare('SELECT * FROM worktree_state WHERE chat_id = ?').get(chatId) as
      StateRow | undefined;
    return row ? toState(row) : undefined;
  }

  timeline(chatId: number): WorktreeTransition[] {
    return (
      this.db
        .prepare('SELECT * FROM worktree_transitions WHERE chat_id = ? ORDER BY id')
        .all(chatId) as unknown as TransitionRow[]
    ).map(toTransition);
  }

  /**
   * Moves the chat to `input.state`. A new state updates the row and adds a Timeline entry in one
   * transaction, then publishes `state_changed`. The same state with other detail or progress only
   * updates the row.
   */
  transition(chatId: number, input: TransitionInput): TransitionResult {
    if (!WORKTREE_STATE_IDS.includes(input.state)) {
      throw new InvalidStateError(`Estado desconocido: ${input.state}`);
    }
    if (!ACTORS.includes(input.actor)) {
      throw new InvalidStateError(`Actor desconocido: ${input.actor}`);
    }
    if (input.blockedReason != null && !BLOCKED_REASONS.includes(input.blockedReason)) {
      throw new InvalidStateError(`Motivo de bloqueo desconocido: ${input.blockedReason}`);
    }
    const now = this.now();
    const previous = this.get(chatId);
    const changed = previous?.state !== input.state;
    const entry = changed || input.record === true;
    const columns = [
      input.state,
      input.detail ?? null,
      input.phase ?? null,
      input.sprintCurrent ?? null,
      input.sprintClosed ?? null,
      input.sprintTotal ?? null,
      input.taskDone ?? null,
      input.taskTotal ?? null,
      input.openDebt ?? null,
      input.blockedReason ?? null,
      input.actor,
      input.role ?? null,
      input.model ?? null,
    ];
    let event;
    this.db.exec('BEGIN');
    try {
      if (previous === undefined) {
        this.db
          .prepare(
            `INSERT INTO worktree_state (state, detail, phase, sprint_current, sprint_closed, sprint_total,
               task_done, task_total, open_debt, blocked_reason, actor, role, model, chat_id, since, previous_state)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(...columns, chatId, now);
      } else {
        this.db
          .prepare(
            `UPDATE worktree_state SET state = ?, detail = ?, phase = ?, sprint_current = ?, sprint_closed = ?,
               sprint_total = ?, task_done = ?, task_total = ?, open_debt = ?, blocked_reason = ?, actor = ?,
               role = ?, model = ?, since = ?, previous_state = ? WHERE chat_id = ?`,
          )
          .run(
            ...columns,
            changed ? now : previous.since,
            changed ? previous.state : previous.previousState,
            chatId,
          );
      }
      if (entry) {
        this.db
          .prepare(
            `INSERT INTO worktree_transitions (chat_id, from_state, to_state, reason, actor, role, model, data, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            chatId,
            previous?.state ?? null,
            input.state,
            input.reason ?? null,
            input.actor,
            input.role ?? null,
            input.model ?? null,
            input.data === undefined ? null : JSON.stringify(input.data),
            now,
          );
        event = this.chats.appendEvent(chatId, 'state_changed', {
          from: previous?.state ?? null,
          to: input.state,
          reason: input.reason ?? null,
          actor: input.actor,
        });
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (event) this.bus.publish(event);
    const state = this.get(chatId);
    if (!state) throw new Error('State write failed');
    return { state, changed };
  }
}
