import type { Db } from '../db/index.js';

/** `reauth`: a fresh TOTP asked again, with a session, before a high-impact action. */
export type AttemptStep = 'password' | 'totp' | 'recovery' | 'reauth';

export interface Attempt {
  username: string;
  ip: string;
  userAgent: string | undefined;
  step: AttemptStep;
  success: boolean;
  reason: string | undefined;
}

/** Every login or re-auth attempt is audited, successful or not. Passwords and codes are never stored. */
export class LoginAudit {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  record(attempt: Attempt): void {
    this.db
      .prepare(
        'INSERT INTO login_attempts (username, ip, success, reason, at, user_agent, step) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        attempt.username.slice(0, 100),
        attempt.ip,
        attempt.success ? 1 : 0,
        attempt.reason ?? null,
        this.now(),
        attempt.userAgent?.slice(0, 300) ?? null,
        attempt.step,
      );
  }
}
