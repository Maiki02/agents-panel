import type { AgentSession, ModelProvider, ModelRole } from '@agents-panel/shared';
import type { Db } from '../db/index.js';

interface SessionRow {
  id: number;
  chat_id: number;
  role: ModelRole;
  provider: ModelProvider;
  model: string;
  sdk_session_id: string | null;
  sprint_n: number | null;
  started_at: number;
  ended_at: number | null;
  result: string | null;
}

function toSession(row: SessionRow): AgentSession {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    provider: row.provider,
    model: row.model,
    sdkSessionId: row.sdk_session_id,
    sprintN: row.sprint_n,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    result: row.result,
  };
}

export class AgentSessionRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  open(
    chatId: number,
    role: ModelRole,
    provider: ModelProvider,
    model: string,
    sprintN: number | null = null,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO agent_sessions (chat_id, role, provider, model, sprint_n, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(chatId, role, provider, model, sprintN, this.now());
    return Number(result.lastInsertRowid);
  }

  setSdkSessionId(id: number, sdkSessionId: string): void {
    this.db
      .prepare('UPDATE agent_sessions SET sdk_session_id = ? WHERE id = ?')
      .run(sdkSessionId, id);
  }

  close(id: number, result: string): void {
    this.db
      .prepare('UPDATE agent_sessions SET ended_at = ?, result = ? WHERE id = ?')
      .run(this.now(), result, id);
  }

  listByChat(chatId: number): AgentSession[] {
    return (
      this.db
        .prepare('SELECT * FROM agent_sessions WHERE chat_id = ? ORDER BY id')
        .all(chatId) as unknown as SessionRow[]
    ).map(toSession);
  }
}
