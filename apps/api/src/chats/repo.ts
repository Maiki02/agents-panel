import type { Chat, ChatEvent, ChatKind, ChatStatus } from '@agents-panel/shared';
import type { Db } from '../db/index.js';

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

function toChat(row: ChatRow): Chat {
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
}

export class ChatRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  create(input: NewChat): Chat {
    const now = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO chats (project_id, kind, slug, title, worktree_path, branch, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.kind,
        input.slug,
        input.title,
        input.worktreePath,
        input.branch,
        input.status,
        now,
        now,
      );
    const chat = this.findById(Number(result.lastInsertRowid));
    if (!chat) throw new Error('Chat insert failed');
    return chat;
  }

  findById(id: number): Chat | undefined {
    const row = this.db.prepare(`${SELECT_CHAT} WHERE c.id = ?`).get(id) as ChatRow | undefined;
    return row ? toChat(row) : undefined;
  }

  list(projectId?: number): Chat[] {
    const where = projectId === undefined ? '' : ' WHERE c.project_id = ?';
    const args = projectId === undefined ? [] : [projectId];
    return (
      this.db
        .prepare(`${SELECT_CHAT}${where} ORDER BY c.updated_at DESC, c.id DESC`)
        .all(...args) as unknown as ChatRow[]
    ).map(toChat);
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM chats WHERE id = ?').run(id);
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

  eventsAfter(chatId: number, afterSeq = 0, limit = 1000): ChatEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM chat_events WHERE chat_id = ? AND seq > ? ORDER BY seq LIMIT ?')
        .all(chatId, afterSeq, limit) as unknown as EventRow[]
    ).map(toEvent);
  }
}
