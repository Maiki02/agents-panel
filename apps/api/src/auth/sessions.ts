import { createHash, randomBytes } from 'node:crypto';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { Db } from '../db/index.js';

export const SESSION_COOKIE = '__Host-panel_session';

export interface Session {
  readonly id: number;
  readonly userId: number;
  readonly csrfToken: string;
}

export interface SessionTimings {
  readonly idleTtlSeconds: number;
  readonly absoluteTtlSeconds: number;
}

/** Attributes shared by every auth cookie. The __Host- prefix requires Secure, Path=/ and no Domain. */
export function cookieOptions(maxAgeSeconds?: number): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    ...(maxAgeSeconds === undefined ? {} : { maxAge: maxAgeSeconds }),
  };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface SessionRow {
  id: number;
  user_id: number;
  csrf_token: string;
  created_at: number;
  last_seen_at: number;
}

export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly timings: SessionTimings,
    private readonly now: () => number = Date.now,
  ) {}

  get absoluteTtlSeconds(): number {
    return this.timings.absoluteTtlSeconds;
  }

  /** Creates a session and returns the opaque token; only its SHA-256 is stored. */
  create(userId: number): { token: string; csrfToken: string } {
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const now = this.now();
    this.db
      .prepare(
        'INSERT INTO sessions (user_id, token_hash, csrf_token, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(userId, hashToken(token), csrfToken, now, now);
    return { token, csrfToken };
  }

  /** Returns the live session for a token, sliding the idle window; expired sessions are deleted. */
  validate(token: string | undefined): Session | undefined {
    if (!token) return undefined;
    const tokenHash = hashToken(token);
    const row = this.db
      .prepare(
        'SELECT id, user_id, csrf_token, created_at, last_seen_at FROM sessions WHERE token_hash = ?',
      )
      .get(tokenHash) as SessionRow | undefined;
    if (!row) return undefined;
    const now = this.now();
    const idleExpired = now - row.last_seen_at > this.timings.idleTtlSeconds * 1000;
    const absoluteExpired = now - row.created_at > this.timings.absoluteTtlSeconds * 1000;
    if (idleExpired || absoluteExpired) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
      return undefined;
    }
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, row.id);
    return { id: row.id, userId: row.user_id, csrfToken: row.csrf_token };
  }

  destroy(token: string | undefined): void {
    if (!token) return;
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  destroyAllForUser(userId: number): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}
