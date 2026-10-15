import type { GitAccount, GitProvider } from '@agents-panel/shared';
import { decryptParts, deriveKey, encryptParts, type EncryptedParts } from '../auth/crypto.js';
import type { Db } from '../db/index.js';

interface GitAccountRow {
  id: number;
  provider: GitProvider;
  name: string;
  host: string;
  username: string;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  created_at: number;
  updated_at: number;
}

export class GitAccountNotFoundError extends Error {}
export class GitAccountConflictError extends Error {}

/** Versioned purpose: the effective HKDF info is `agents-panel:git-accounts-v1`. */
const KEY_PURPOSE = 'git-accounts-v1';

export interface NewGitAccountRecord {
  provider: GitProvider;
  name: string;
  host: string;
  username: string;
  token: string;
}

/**
 * Git accounts with the token encrypted at rest (AES-256-GCM). The AAD is
 * `<id>:<provider>:<host>`, so a ciphertext moved to another row stops decrypting.
 * Only `readToken` returns the token; it never goes to clients or logs.
 */
export class GitAccountRepository {
  private readonly key: Buffer;

  constructor(
    private readonly db: Db,
    secret: Buffer,
    private readonly now: () => number = Date.now,
  ) {
    this.key = deriveKey(secret, KEY_PURPOSE);
  }

  list(): GitAccount[] {
    return (
      this.db
        .prepare('SELECT * FROM git_accounts ORDER BY name')
        .all() as unknown as GitAccountRow[]
    ).map(toAccount);
  }

  findById(id: number): GitAccount | undefined {
    const row = this.row(id);
    return row ? toAccount(row) : undefined;
  }

  create(input: NewGitAccountRecord): GitAccount {
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT 1 FROM git_accounts WHERE name = ?').get(input.name))
        throw new GitAccountConflictError(`Ya existe una cuenta llamada ${input.name}`);
      // Placeholder blobs: the AAD needs the id, which the insert assigns.
      const result = this.db
        .prepare(
          `INSERT INTO git_accounts (provider, name, host, username, ciphertext, iv, tag, created_at, updated_at)
           VALUES (?, ?, ?, ?, x'00', x'00', x'00', ?, ?)`,
        )
        .run(input.provider, input.name, input.host, input.username, now, now);
      const id = Number(result.lastInsertRowid);
      this.storeToken(id, input.provider, input.host, input.token);
      this.db.exec('COMMIT');
      return toAccount(this.mustGet(id));
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  rename(id: number, name: string): GitAccount {
    const row = this.mustGet(id);
    const clash = this.db
      .prepare('SELECT id FROM git_accounts WHERE name = ? AND id <> ?')
      .get(name, id);
    if (clash) throw new GitAccountConflictError(`Ya existe una cuenta llamada ${name}`);
    this.db
      .prepare('UPDATE git_accounts SET name = ?, updated_at = ? WHERE id = ?')
      .run(name, this.now(), row.id);
    return toAccount(this.mustGet(id));
  }

  replaceToken(id: number, username: string, token: string): GitAccount {
    const row = this.mustGet(id);
    this.storeToken(id, row.provider, row.host, token);
    this.db.prepare('UPDATE git_accounts SET username = ? WHERE id = ?').run(username, id);
    return toAccount(this.mustGet(id));
  }

  /** Projects that point at the account. */
  projectCount(id: number): number {
    const row = this.db
      .prepare('SELECT count(*) AS n FROM projects WHERE git_account_id = ?')
      .get(id) as { n: number };
    return row.n;
  }

  remove(id: number): void {
    this.mustGet(id);
    if (this.projectCount(id) > 0)
      throw new GitAccountConflictError('La cuenta está asignada a un proyecto');
    this.db.prepare('DELETE FROM git_accounts WHERE id = ?').run(id);
  }

  /** The decrypted token, or null when it can no longer be decrypted. */
  readToken(id: number): string | null {
    const row = this.row(id);
    if (!row) return null;
    const parts: EncryptedParts = {
      ciphertext: Buffer.from(row.ciphertext),
      iv: Buffer.from(row.iv),
      tag: Buffer.from(row.tag),
    };
    try {
      return decryptParts(this.key, parts, aad(row.id, row.provider, row.host));
    } catch {
      return null;
    }
  }

  private storeToken(id: number, provider: GitProvider, host: string, token: string): void {
    const parts = encryptParts(this.key, token, aad(id, provider, host));
    this.db
      .prepare(
        'UPDATE git_accounts SET ciphertext = ?, iv = ?, tag = ?, updated_at = ? WHERE id = ?',
      )
      .run(parts.ciphertext, parts.iv, parts.tag, this.now(), id);
  }

  private row(id: number): GitAccountRow | undefined {
    return this.db.prepare('SELECT * FROM git_accounts WHERE id = ?').get(id) as
      GitAccountRow | undefined;
  }

  private mustGet(id: number): GitAccountRow {
    const row = this.row(id);
    if (!row) throw new GitAccountNotFoundError(`Cuenta de git no encontrada: ${String(id)}`);
    return row;
  }
}

function toAccount(row: GitAccountRow): GitAccount {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    host: row.host,
    username: row.username,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function aad(id: number, provider: GitProvider, host: string): Buffer {
  return Buffer.from(`${String(id)}:${provider}:${host}`, 'utf8');
}
