import {
  DEFAULT_MODELS,
  DEFAULT_PROVIDER,
  type Chat,
  type ChatEvent,
  type ChatKind,
  type ChatStatus,
  type ModelProvider,
  type ModelSelection,
} from '@agents-panel/shared';
import type { Db } from '../db/index.js';
import { netRuntimeMs, type Interval } from './runtime.js';

interface ChatRow {
  id: number;
  project_id: number;
  project_name: string;
  kind: ChatKind;
  slug: string;
  title: string;
  worktree_path: string;
  branch: string;
  sdk_session_id: string | null;
  status: ChatStatus;
  provider: ModelProvider;
  thinker_model: string;
  executor_model: string;
  created_at: number;
  updated_at: number;
}

interface EventRow {
  id: number;
  chat_id: number;
  seq: number;
  type: string;
  payload: string;
  created_at: number;
}

const SELECT_CHAT =
  'SELECT c.*, p.name AS project_name FROM chats c JOIN projects p ON p.id = c.project_id';

function toChat(row: ChatRow): Omit<Chat, 'runtimeMs' | 'runtimeApprox'> {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    kind: row.kind,
    slug: row.slug,
    title: row.title,
    worktreePath: row.worktree_path,
    branch: row.branch,
    sdkSessionId: row.sdk_session_id,
    status: row.status,
    models: { provider: row.provider, thinker: row.thinker_model, executor: row.executor_model },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvent(row: EventRow): ChatEvent {
  return {
    id: row.id,
    chatId: row.chat_id,
    seq: row.seq,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
    createdAt: row.created_at,
  };
}

export interface NewChat {
  projectId: number;
  kind: ChatKind;
  slug: string;
  title: string;
  worktreePath: string;
  branch: string;
  status: ChatStatus;
  /** Already resolved (chat override > project > default); defaults when omitted. */
  models?: ModelSelection;
}

export class ChatRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  create(input: NewChat): Chat {
    const now = this.now();
    const models = input.models ?? { provider: DEFAULT_PROVIDER, ...DEFAULT_MODELS };
    const result = this.db
      .prepare(
        `INSERT INTO chats (project_id, kind, slug, title, worktree_path, branch, status, provider, thinker_model, executor_model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.kind,
        input.slug,
        input.title,
        input.worktreePath,
        input.branch,
        input.status,
        models.provider,
        models.thinker,
        models.executor,
        now,
        now,
      );
    const chat = this.findById(Number(result.lastInsertRowid));
    if (!chat) throw new Error('Chat insert failed');
    return chat;
  }

  findById(id: number): Chat | undefined {
    const row = this.db.prepare(`${SELECT_CHAT} WHERE c.id = ?`).get(id) as ChatRow | undefined;
    return row ? this.withRuntime([toChat(row)])[0] : undefined;
  }

  list(projectId?: number): Chat[] {
    const where = projectId === undefined ? '' : ' WHERE c.project_id = ?';
    const args = projectId === undefined ? [] : [projectId];
    return this.withRuntime(
      (
        this.db
          .prepare(`${SELECT_CHAT}${where} ORDER BY c.updated_at DESC, c.id DESC`)
          .all(...args) as unknown as ChatRow[]
      ).map(toChat),
    );
  }

  /**
   * Adds the net runtime to each chat with three queries for all of them. A chat is approximate when
   * it was created before the panel steps were measured (migration `panel_steps`).
   */
  private withRuntime(chats: Omit<Chat, 'runtimeMs' | 'runtimeApprox'>[]): Chat[] {
    if (chats.length === 0) return [];
    const ids = chats.map((chat) => chat.id);
    const marks = ids.map(() => '?').join(', ');
    const intervalsOf = (sql: string): Map<number, Interval[]> => {
      const byChat = new Map<number, Interval[]>();
      for (const row of this.db.prepare(sql).all(...ids)) {
        const chatId = Number(row['chat_id']);
        const end = row['end_at'];
        const list = byChat.get(chatId) ?? [];
        list.push({ start: Number(row['start_at']), end: end === null ? null : Number(end) });
        byChat.set(chatId, list);
      }
      return byChat;
    };
    const sessions = intervalsOf(
      `SELECT chat_id, started_at AS start_at, ended_at AS end_at FROM agent_sessions WHERE chat_id IN (${marks})`,
    );
    const steps = intervalsOf(
      `SELECT chat_id, started_at AS start_at, ended_at AS end_at FROM panel_steps WHERE chat_id IN (${marks})`,
    );
    // Pending questions count up to now; a cancelled one has no answered_at (its end is unknown), so
    // it subtracts nothing.
    const waits = intervalsOf(
      `SELECT chat_id, created_at AS start_at,
              CASE WHEN status = 'pending' THEN NULL ELSE COALESCE(answered_at, created_at) END AS end_at
         FROM pending_questions WHERE chat_id IN (${marks})`,
    );
    const marker = this.db
      .prepare('SELECT applied_at FROM schema_migrations WHERE name = ?')
      .get('panel_steps') as { applied_at: number } | undefined;
    const measuredSince = marker === undefined ? 0 : marker.applied_at;
    const now = this.now();
    return chats.map((chat) => ({
      ...chat,
      runtimeMs: netRuntimeMs(
        [...(sessions.get(chat.id) ?? []), ...(steps.get(chat.id) ?? [])],
        waits.get(chat.id) ?? [],
        now,
      ),
      runtimeApprox: chat.createdAt < measuredSince,
    }));
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM chats WHERE id = ?').run(id);
  }

  /** An approved idea becomes a scope or a work: same chat, worktree and session. */
  setKind(id: number, kind: ChatKind): void {
    this.db
      .prepare('UPDATE chats SET kind = ?, updated_at = ? WHERE id = ?')
      .run(kind, this.now(), id);
  }

  setStatus(id: number, status: ChatStatus): void {
    this.db
      .prepare('UPDATE chats SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, this.now(), id);
  }

  setSessionId(id: number, sessionId: string): void {
    this.db
      .prepare('UPDATE chats SET sdk_session_id = ?, updated_at = ? WHERE id = ?')
      .run(sessionId, this.now(), id);
  }

  /** Chats whose turn is marked running (read before `markRunningAsInterrupted` on startup). */
  listRunning(): Chat[] {
    return this.withRuntime(
      (
        this.db
          .prepare(`${SELECT_CHAT} WHERE c.status = 'running' ORDER BY c.id`)
          .all() as unknown as ChatRow[]
      ).map(toChat),
    );
  }

  /** On startup nothing is really running: chats left as running become interrupted. */
  markRunningAsInterrupted(): number {
    const result = this.db
      .prepare("UPDATE chats SET status = 'interrupted', updated_at = ? WHERE status = 'running'")
      .run(this.now());
    return Number(result.changes);
  }

  /** Appends an event with the next seq for the chat (seq starts at 1). */
  appendEvent(chatId: number, type: string, payload: unknown): ChatEvent {
    const createdAt = this.now();
    const row = this.db
      .prepare(
        `INSERT INTO chat_events (chat_id, seq, type, payload, created_at)
         VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_events WHERE chat_id = ?), ?, ?, ?)
         RETURNING *`,
      )
      .get(chatId, chatId, type, JSON.stringify(payload), createdAt) as unknown as EventRow;
    this.db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(createdAt, chatId);
    return toEvent(row);
  }

  /** Highest seq of the chat's events (0 when it has none). */
  lastSeq(chatId: number): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM chat_events WHERE chat_id = ?')
      .get(chatId) as { seq: number };
    return row.seq;
  }

  /** Every event after `afterSeq`, read in pages. */
  allEventsAfter(chatId: number, afterSeq: number): ChatEvent[] {
    const all: ChatEvent[] = [];
    for (let cursor = afterSeq; ;) {
      const page = this.eventsAfter(chatId, cursor, 500);
      all.push(...page);
      const last = page.at(-1);
      if (last === undefined || page.length < 500) return all;
      cursor = last.seq;
    }
  }

  eventsAfter(chatId: number, afterSeq = 0, limit = 1000): ChatEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM chat_events WHERE chat_id = ? AND seq > ? ORDER BY seq LIMIT ?')
        .all(chatId, afterSeq, limit) as unknown as EventRow[]
    ).map(toEvent);
  }
}
