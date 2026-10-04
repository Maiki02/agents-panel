import { createHmac, randomBytes } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import type { Db } from '../db/index.js';
import { decrypt, deriveKey, encrypt } from './crypto.js';

const ISSUER = 'agents-panel';
const PERIOD = 30;
const WINDOW = 1;
const RECOVERY_CODE_COUNT = 10;

function totpFor(secretBase32: string, label: string): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: PERIOD,
    secret: Secret.fromBase32(secretBase32),
  });
}

export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function totpUri(username: string, secretBase32: string): string {
  return totpFor(secretBase32, username).toString();
}

/** Returns the matched time step (for replay protection) or undefined. Accepts ±1 step. */
export function checkTotp(secretBase32: string, code: string, nowMs: number): number | undefined {
  const delta = totpFor(secretBase32, 'check').validate({
    token: code,
    window: WINDOW,
    timestamp: nowMs,
  });
  if (delta === null) return undefined;
  return Math.floor(nowMs / 1000 / PERIOD) + delta;
}

export function generateTotpCode(secretBase32: string, nowMs: number): string {
  return totpFor(secretBase32, 'gen').generate({ timestamp: nowMs });
}

export class SecondFactorRepository {
  private readonly encKey: Buffer;
  private readonly hashKey: Buffer;

  constructor(
    private readonly db: Db,
    secret: Buffer,
    private readonly now: () => number = Date.now,
  ) {
    this.encKey = deriveKey(secret, 'totp-secret');
    this.hashKey = deriveKey(secret, 'recovery-code');
  }

  /** Stores (replacing any previous) TOTP secret encrypted with AES-256-GCM. */
  setTotpSecret(userId: number, secretBase32: string): void {
    this.db
      .prepare(
        `INSERT INTO user_totp (user_id, secret_encrypted, confirmed, last_used_step, created_at)
         VALUES (?, ?, 1, NULL, ?)
         ON CONFLICT(user_id) DO UPDATE SET secret_encrypted = excluded.secret_encrypted,
           confirmed = 1, last_used_step = NULL, created_at = excluded.created_at`,
      )
      .run(userId, encrypt(this.encKey, secretBase32), this.now());
  }

  clear(userId: number): void {
    this.db.prepare('DELETE FROM user_totp WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
  }

  getTotpSecret(userId: number): string | undefined {
    const row = this.db
      .prepare('SELECT secret_encrypted FROM user_totp WHERE user_id = ? AND confirmed = 1')
      .get(userId) as { secret_encrypted: string } | undefined;
    return row ? decrypt(this.encKey, row.secret_encrypted) : undefined;
  }

  /** Verifies a code and burns its time step so the same code cannot be used twice. */
  consumeTotp(userId: number, code: string): boolean {
    const secret = this.getTotpSecret(userId);
    if (!secret) return false;
    const step = checkTotp(secret, code, this.now());
    if (step === undefined) return false;
    const result = this.db
      .prepare(
        'UPDATE user_totp SET last_used_step = ? WHERE user_id = ? AND (last_used_step IS NULL OR last_used_step < ?)',
      )
      .run(step, userId, step);
    return Number(result.changes) === 1;
  }

  private hashRecovery(code: string): string {
    const normalized = code.replace(/[\s-]/g, '').toLowerCase();
    return createHmac('sha256', this.hashKey).update(normalized).digest('hex');
  }

  /** Replaces all recovery codes; the plaintext is returned once and never stored. */
  regenerateRecoveryCodes(userId: number): string[] {
    this.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
    const insert = this.db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
    const codes: string[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      const raw = randomBytes(5).toString('hex');
      const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
      insert.run(userId, this.hashRecovery(code));
      codes.push(code);
    }
    return codes;
  }

  consumeRecoveryCode(userId: number, code: string): boolean {
    const result = this.db
      .prepare(
        'UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
      )
      .run(this.now(), userId, this.hashRecovery(code));
    return Number(result.changes) === 1;
  }
}
