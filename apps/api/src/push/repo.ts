import type { PushSubscriptionInfo } from '@agents-panel/shared';
import type { Db } from '../db/index.js';

interface Row {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  name: string;
  user_agent: string | null;
  created_at: number;
  last_success_at: number | null;
}

/** A stored subscription with the keys needed to send; never leaves the API. */
export interface StoredPushSubscription extends PushSubscriptionInfo {
  userId: number;
  p256dh: string;
  auth: string;
}

function toStored(row: Row): StoredPushSubscription {
  return {
    id: row.id,
    userId: row.user_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    name: row.name,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastSuccessAt: row.last_success_at,
  };
}

export function toInfo(stored: StoredPushSubscription): PushSubscriptionInfo {
  return {
    id: stored.id,
    endpoint: stored.endpoint,
    name: stored.name,
    userAgent: stored.userAgent,
    createdAt: stored.createdAt,
    lastSuccessAt: stored.lastSuccessAt,
  };
}

/** Devices (browsers, phones) one user may have subscribed at the same time. */
export const MAX_SUBSCRIPTIONS_PER_USER = 10;

/** Browsers and phones that receive notifications, per user. */
export class PushSubscriptionRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  listForUser(userId: number): StoredPushSubscription[] {
    return (
      this.db
        .prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY id')
        .all(userId) as unknown as Row[]
    ).map(toStored);
  }

  /** True when this user already has a subscription for the endpoint (re-subscribing is free). */
  hasEndpoint(userId: number, endpoint: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 AS found FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
        .get(userId, endpoint) !== undefined
    );
  }

  count(userId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS total FROM push_subscriptions WHERE user_id = ?')
      .get(userId) as { total: number };
    return row.total;
  }

  listAll(): StoredPushSubscription[] {
    return (
      this.db.prepare('SELECT * FROM push_subscriptions ORDER BY id').all() as unknown as Row[]
    ).map(toStored);
  }

  /** Only the owner's: another user's id answers undefined, like a missing one. */
  findForUser(userId: number, id: number): StoredPushSubscription | undefined {
    const row = this.db
      .prepare('SELECT * FROM push_subscriptions WHERE id = ? AND user_id = ?')
      .get(id, userId) as Row | undefined;
    return row ? toStored(row) : undefined;
  }

  /**
   * Idempotent by endpoint: the same endpoint updates its keys, name and user agent instead of
   * adding a row. An endpoint that belonged to another user moves to this one (same browser).
   */
  upsert(
    userId: number,
    input: {
      endpoint: string;
      p256dh: string;
      auth: string;
      name: string;
      userAgent: string | null;
    },
  ): StoredPushSubscription {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, name, user_agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
           auth = excluded.auth, name = excluded.name, user_agent = excluded.user_agent`,
      )
      .run(
        userId,
        input.endpoint,
        input.p256dh,
        input.auth,
        input.name,
        input.userAgent,
        this.now(),
      );
    const row = this.db
      .prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?')
      .get(input.endpoint) as unknown as Row;
    return toStored(row);
  }

  rename(userId: number, id: number, name: string): StoredPushSubscription | undefined {
    this.db
      .prepare('UPDATE push_subscriptions SET name = ? WHERE id = ? AND user_id = ?')
      .run(name, id, userId);
    return this.findForUser(userId, id);
  }

  markSuccess(id: number): void {
    this.db
      .prepare('UPDATE push_subscriptions SET last_success_at = ? WHERE id = ?')
      .run(this.now(), id);
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id);
  }
}
