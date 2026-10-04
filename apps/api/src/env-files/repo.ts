import type { EnvFileInfo } from '@agents-panel/shared';
import { decryptParts, deriveKey, encryptParts, type EncryptedParts } from '../auth/crypto.js';
import type { Db } from '../db/index.js';

interface EnvFileRow {
  rel_path: string;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  key_names: string;
  updated_at: number;
}

/** A decrypted .env, or a marker when it can no longer be decrypted. */
export type EnvFileContent = { path: string; content: string } | { path: string; unreadable: true };

export type EnvUpsertResult = 'created' | 'replaced';

/** Versioned purpose: the effective HKDF info is `agents-panel:env-files-v1`. */
const KEY_PURPOSE = 'env-files-v1';

/**
 * Development .env files per project, encrypted at rest with AES-256-GCM.
 * The AAD is `<projectId>:<relPath>`, so a ciphertext moved to another row stops decrypting.
 * Only `readAll` ever returns content; callers must not send it to clients or logs.
 */
export class EnvFileRepository {
  private readonly key: Buffer;

  constructor(
    private readonly db: Db,
    secret: Buffer,
    private readonly now: () => number = Date.now,
  ) {
    this.key = deriveKey(secret, KEY_PURPOSE);
  }

  /** Stores `content` for (projectId, relPath); the caller already validated both. */
  upsert(projectId: number, relPath: string, content: string, keyNames: string[]): EnvUpsertResult {
    const existing = this.db
      .prepare('SELECT 1 FROM project_env_files WHERE project_id = ? AND rel_path = ?')
      .get(projectId, relPath);
    const parts = encryptParts(this.key, content, aad(projectId, relPath));
    this.db
      .prepare(
        `INSERT INTO project_env_files (project_id, rel_path, ciphertext, iv, tag, key_names, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, rel_path) DO UPDATE SET
           ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
           key_names = excluded.key_names, updated_at = excluded.updated_at`,
      )
      .run(
        projectId,
        relPath,
        parts.ciphertext,
        parts.iv,
        parts.tag,
        JSON.stringify(keyNames),
        this.now(),
      );
    return existing ? 'replaced' : 'created';
  }

  /** Metadata only; `readable` is computed by trying to decrypt, the text is discarded. */
  list(projectId: number): EnvFileInfo[] {
    return this.rows(projectId).map((row) => ({
      path: row.rel_path,
      keyNames: JSON.parse(row.key_names) as string[],
      updatedAt: row.updated_at,
      readable: this.tryDecrypt(projectId, row) !== null,
    }));
  }

  /** Returns true if a row was deleted. */
  remove(projectId: number, relPath: string): boolean {
    const result = this.db
      .prepare('DELETE FROM project_env_files WHERE project_id = ? AND rel_path = ?')
      .run(projectId, relPath);
    return result.changes > 0;
  }

  readAll(projectId: number): EnvFileContent[] {
    return this.rows(projectId).map((row) => {
      const content = this.tryDecrypt(projectId, row);
      return content === null
        ? { path: row.rel_path, unreadable: true as const }
        : { path: row.rel_path, content };
    });
  }

  private rows(projectId: number): EnvFileRow[] {
    return this.db
      .prepare(
        `SELECT rel_path, ciphertext, iv, tag, key_names, updated_at
         FROM project_env_files WHERE project_id = ? ORDER BY rel_path`,
      )
      .all(projectId) as unknown as EnvFileRow[];
  }

  private tryDecrypt(projectId: number, row: EnvFileRow): string | null {
    const parts: EncryptedParts = {
      ciphertext: Buffer.from(row.ciphertext),
      iv: Buffer.from(row.iv),
      tag: Buffer.from(row.tag),
    };
    try {
      return decryptParts(this.key, parts, aad(projectId, row.rel_path));
    } catch {
      return null;
    }
  }
}

function aad(projectId: number, relPath: string): Buffer {
  return Buffer.from(`${String(projectId)}:${relPath}`, 'utf8');
}
