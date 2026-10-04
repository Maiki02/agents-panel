import type { Db } from '../db/index.js';
import { hashPassword, verifyDummy, verifyPassword } from './password.js';

export interface User {
  readonly id: number;
  readonly username: string;
  readonly passwordHash: string;
  readonly failedAttempts: number;
  readonly lockedUntil: number | null;
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  failed_attempts: number;
  locked_until: number | null;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    failedAttempts: row.failed_attempts,
    lockedUntil: row.locked_until,
  };
}

export class UserRepository {
  constructor(private readonly db: Db) {}

  findByUsername(username: string): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      UserRow | undefined;
    return row ? toUser(row) : undefined;
  }

  findById(id: number): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toUser(row) : undefined;
  }

  list(): User[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY id').all() as unknown as UserRow[]).map(
      toUser,
    );
  }

  async create(username: string, password: string): Promise<User> {
    const passwordHash = await hashPassword(password);
    const result = this.db
      .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
      .run(username, passwordHash, Date.now());
    const user = this.findById(Number(result.lastInsertRowid));
    if (!user) throw new Error('User insert failed');
    return user;
  }

  isLocked(user: User, now: number): boolean {
    return user.lockedUntil !== null && user.lockedUntil > now;
  }

  /** Counts a failed password or second-factor attempt; the Nth consecutive failure locks the account. */
  registerFailure(id: number, now: number, maxAttempts: number, lockMs: number): void {
    this.db
      .prepare(
        `UPDATE users SET
           failed_attempts = CASE WHEN failed_attempts + 1 >= ? THEN 0 ELSE failed_attempts + 1 END,
           locked_until = CASE WHEN failed_attempts + 1 >= ? THEN ? ELSE locked_until END
         WHERE id = ?`,
      )
      .run(maxAttempts, maxAttempts, now + lockMs, id);
  }

  clearFailures(id: number): void {
    this.db
      .prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?')
      .run(id);
  }

  async setPassword(id: number, password: string): Promise<void> {
    const passwordHash = await hashPassword(password);
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  }

  /** Returns the user only if the password matches; unknown users still cost one Argon2id check. */
  async verifyCredentials(username: string, password: string): Promise<User | undefined> {
    const user = this.findByUsername(username);
    if (!user) {
      await verifyDummy(password);
      return undefined;
    }
    return (await verifyPassword(user.passwordHash, password)) ? user : undefined;
  }
}
