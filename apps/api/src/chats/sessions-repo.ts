import type { AgentSession, AutopilotStep, ModelProvider, ModelRole } from '@agents-panel/shared';
import type { Db } from '../db/index.js';

interface SessionRow {
  id: number;
  chat_id: number;
  role: ModelRole;
  provider: ModelProvider;
  model: string;
  sdk_session_id: string | null;
  sprint_n: number | null;
  step: AutopilotStep;
  policy_version: number | null;
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
    step: row.step,
    policyVersion: row.policy_version,
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
    pilot: { step: AutopilotStep; policyVersion: number | null } = {
      step: 'manual',
      policyVersion: null,
    },
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO agent_sessions (chat_id, role, provider, model, sprint_n, step, policy_version, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(chatId, role, provider, model, sprintN, pilot.step, pilot.policyVersion, this.now());
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

  /** Latest session of the chat that never ended (the process died with it); undefined if none. */
  lastOpen(chatId: number): AgentSession | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM agent_sessions WHERE chat_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1',
      )
      .get(chatId) as SessionRow | undefined;
    return row ? toSession(row) : undefined;
  }

  /** Closes every session still open: at startup nothing of the previous process is running. */
  closeOpen(result: string): void {
    this.db
      .prepare('UPDATE agent_sessions SET ended_at = ?, result = ? WHERE ended_at IS NULL')
      .run(this.now(), result);
  }

  listByChat(chatId: number): AgentSession[] {
    return (
      this.db
        .prepare('SELECT * FROM agent_sessions WHERE chat_id = ? ORDER BY id')
        .all(chatId) as unknown as SessionRow[]
    ).map(toSession);
  }
}
