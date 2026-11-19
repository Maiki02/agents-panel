import type {
  AgentSession,
  AutopilotStep,
  ModelProvider,
  ModelRole,
  SessionUsage,
} from '@agents-panel/shared';
import type { Db } from '../db/index.js';

interface SessionRow {
  id: number;
  chat_id: number;
  role: ModelRole;
  provider: ModelProvider;
  model: string;
  sdk_session_id: string | null;
  account_id: number | null;
  sprint_n: number | null;
  step: AutopilotStep;
  policy_version: number | null;
  started_at: number;
  ended_at: number | null;
  result: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
}

function toSession(row: SessionRow): AgentSession {
  const measured = row.input_tokens !== null && row.cost_usd !== null;
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    provider: row.provider,
    model: row.model,
    sdkSessionId: row.sdk_session_id,
    accountId: row.account_id,
    sprintN: row.sprint_n,
    step: row.step,
    policyVersion: row.policy_version,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    result: row.result,
    usage: measured
      ? {
          inputTokens: row.input_tokens ?? 0,
          outputTokens: row.output_tokens ?? 0,
          cacheReadTokens: row.cache_read_tokens ?? 0,
          cacheCreationTokens: row.cache_creation_tokens ?? 0,
          costUsd: row.cost_usd ?? 0,
        }
      : null,
  };
}

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/** Reads the usage out of an SDK `result` message; null when the payload does not carry it. */
export function usageFromResult(payload: unknown): SessionUsage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = payload as Record<string, unknown>;
  const usage = message['usage'];
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as Record<string, unknown>;
  return {
    inputTokens: num(u['input_tokens']),
    outputTokens: num(u['output_tokens']),
    cacheReadTokens: num(u['cache_read_input_tokens']),
    cacheCreationTokens: num(u['cache_creation_input_tokens']),
    costUsd: num(message['total_cost_usd']),
  };
}

/** Adds the usage of every session that has one. */
export function totalUsage(sessions: readonly AgentSession[]): SessionUsage {
  const total: SessionUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };
  for (const { usage } of sessions) {
    if (!usage) continue;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheCreationTokens += usage.cacheCreationTokens;
    total.costUsd += usage.costUsd;
  }
  return total;
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
    accountId: number | null = null,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO agent_sessions (chat_id, role, provider, model, sprint_n, step, policy_version, account_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chatId,
        role,
        provider,
        model,
        sprintN,
        pilot.step,
        pilot.policyVersion,
        accountId,
        this.now(),
      );
    return Number(result.lastInsertRowid);
  }

  setSdkSessionId(id: number, sdkSessionId: string): void {
    this.db
      .prepare('UPDATE agent_sessions SET sdk_session_id = ? WHERE id = ?')
      .run(sdkSessionId, id);
  }

  /** Keeps the usage of the session's result message (cumulative: the last one wins). */
  setUsage(id: number, usage: SessionUsage): void {
    this.db
      .prepare(
        `UPDATE agent_sessions SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
           cache_creation_tokens = ?, cost_usd = ? WHERE id = ?`,
      )
      .run(
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.cacheCreationTokens,
        usage.costUsd,
        id,
      );
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
