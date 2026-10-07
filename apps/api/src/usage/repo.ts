import type { UsageStatus, UsageWindow } from '@agents-panel/shared';
import type { Db } from '../db/index.js';

interface UsageRow {
  window: string;
  utilization: number | null;
  status: UsageStatus | null;
  resets_at: number | null;
  source: 'event' | 'query';
  observed_at: number;
}

export interface UsageObservation {
  window: string;
  utilization: number | null;
  status: UsageStatus | null;
  /** Epoch milliseconds. */
  resetsAt: number | null;
  source: 'event' | 'query';
}

const STATUSES: readonly string[] = ['allowed', 'allowed_warning', 'rejected'];

function toWindow(row: UsageRow): UsageWindow {
  return {
    window: row.window,
    utilization: row.utilization,
    status: row.status,
    resetsAt: row.resets_at,
    source: row.source,
    observedAt: row.observed_at,
  };
}

/**
 * Reads the info of an SDK `rate_limit_event` payload (`{ rate_limit_info: { status, resetsAt in
 * epoch seconds, rateLimitType, utilization } }`). Returns null when it has no usable window.
 */
export function observationFromRateLimitEvent(payload: unknown): UsageObservation | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const info = (payload as Record<string, unknown>)['rate_limit_info'];
  if (typeof info !== 'object' || info === null) return null;
  const raw = info as Record<string, unknown>;
  const window = raw['rateLimitType'];
  if (typeof window !== 'string' || window === '') return null;
  const utilization = raw['utilization'];
  const status = raw['status'];
  const resetsAt = raw['resetsAt'];
  return {
    window,
    utilization:
      typeof utilization === 'number' && Number.isFinite(utilization)
        ? Math.min(100, Math.max(0, utilization))
        : null,
    status:
      typeof status === 'string' && STATUSES.includes(status) ? (status as UsageStatus) : null,
    resetsAt:
      typeof resetsAt === 'number' && Number.isFinite(resetsAt)
        ? Math.round(resetsAt * 1000)
        : null,
    source: 'event',
  };
}

/** Last observation of each usage window, per account and provider. */
export class UsageRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Keeps only the latest observation of the window for the account. */
  upsert(accountId: number, observation: UsageObservation, provider: 'claude' = 'claude'): void {
    this.db
      .prepare(
        `INSERT INTO provider_usage (account_id, provider, window, utilization, status, resets_at, source, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, provider, window) DO UPDATE SET
           utilization = excluded.utilization,
           status = excluded.status,
           resets_at = excluded.resets_at,
           source = excluded.source,
           observed_at = excluded.observed_at`,
      )
      .run(
        accountId,
        provider,
        observation.window,
        observation.utilization,
        observation.status,
        observation.resetsAt,
        observation.source,
        this.now(),
      );
  }

  /** Windows of the account, ordered by name. */
  listByAccount(accountId: number, provider: 'claude' = 'claude'): UsageWindow[] {
    const rows = this.db
      .prepare(
        'SELECT window, utilization, status, resets_at, source, observed_at FROM provider_usage WHERE account_id = ? AND provider = ? ORDER BY window',
      )
      .all(accountId, provider) as unknown as UsageRow[];
    return rows.map(toWindow);
  }
}
