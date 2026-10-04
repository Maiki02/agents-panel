import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decryptParts, deriveKey, encryptParts } from '../src/auth/crypto.js';
import { openDatabase, type Db } from '../src/db/index.js';
import { EnvFileRepository } from '../src/env-files/repo.js';
import { TEST_ENV } from './helpers.js';

const SECRET = Buffer.from(TEST_ENV.PANEL_SECRET_KEY, 'utf8');
const OTHER_SECRET = Buffer.from('another-secret-key-another-secret-key-1', 'utf8');
const SENTINEL = 'S3NT1NEL_ENV_VALUE_7d41';
const CONTENT = `DB_HOST=localhost\nAPI_KEY=${SENTINEL}\n`;

function addProject(db: Db, name = 'p'): number {
  const result = db
    .prepare(
      "INSERT INTO projects (name, repo_path, base_branch, created_at) VALUES (?, '/x', 'main', 1)",
    )
    .run(name);
  return Number(result.lastInsertRowid);
}

function setup(): { db: Db; repo: EnvFileRepository; projectId: number; clock: { t: number } } {
  const db = openDatabase(':memory:');
  const clock = { t: 1000 };
  return {
    db,
    repo: new EnvFileRepository(db, SECRET, () => clock.t),
    projectId: addProject(db),
    clock,
  };
}

describe('encryptParts / decryptParts', () => {
  const key = deriveKey(SECRET, 'test');

  it('round-trips with the same AAD and fails with another one', () => {
    const parts = encryptParts(key, SENTINEL, Buffer.from('1:.env'));
    expect(parts.iv).toHaveLength(12);
    expect(parts.tag).toHaveLength(16);
    expect(parts.ciphertext.toString('utf8')).not.toContain(SENTINEL);
    expect(decryptParts(key, parts, Buffer.from('1:.env'))).toBe(SENTINEL);
    expect(() => decryptParts(key, parts, Buffer.from('2:.env'))).toThrow();
    expect(() => decryptParts(key, parts)).toThrow();
  });
});

describe('EnvFileRepository', () => {
  it('creates, then replaces the same path keeping a single row with a new updated_at', () => {
    const { db, repo, projectId, clock } = setup();
    expect(repo.upsert(projectId, '.env', CONTENT, ['DB_HOST', 'API_KEY'])).toBe('created');
    clock.t = 2000;
    expect(repo.upsert(projectId, '.env', 'ONLY=1\n', ['ONLY'])).toBe('replaced');

    const count = db.prepare('SELECT COUNT(*) AS n FROM project_env_files').get() as { n: number };
    expect(count.n).toBe(1);
    expect(repo.list(projectId)).toEqual([
      { path: '.env', keyNames: ['ONLY'], updatedAt: 2000, readable: true },
    ]);
    expect(repo.readAll(projectId)).toEqual([{ path: '.env', content: 'ONLY=1\n' }]);
  });

  it('keeps projects and paths apart, and remove deletes only the given row', () => {
    const { db, repo, projectId } = setup();
    const other = addProject(db, 'q');
    repo.upsert(projectId, '.env', CONTENT, ['DB_HOST', 'API_KEY']);
    repo.upsert(projectId, 'backend/.env', 'B=1\n', ['B']);
    repo.upsert(other, '.env', 'Q=1\n', ['Q']);

    expect(repo.list(projectId).map((f) => f.path)).toEqual(['.env', 'backend/.env']);
    expect(repo.remove(projectId, 'backend/.env')).toBe(true);
    expect(repo.remove(projectId, 'backend/.env')).toBe(false);
    expect(repo.list(projectId).map((f) => f.path)).toEqual(['.env']);
    expect(repo.readAll(other)).toEqual([{ path: '.env', content: 'Q=1\n' }]);
  });

  it('list never returns the content', () => {
    const { repo, projectId } = setup();
    repo.upsert(projectId, '.env', CONTENT, ['DB_HOST', 'API_KEY']);
    const listed = repo.list(projectId);
    expect(JSON.stringify(listed)).not.toContain(SENTINEL);
    expect(listed[0]).toEqual({
      path: '.env',
      keyNames: ['DB_HOST', 'API_KEY'],
      updatedAt: 1000,
      readable: true,
    });
  });

  it('marks files unreadable without throwing when PANEL_SECRET_KEY changed', () => {
    const { db, repo, projectId } = setup();
    repo.upsert(projectId, '.env', CONTENT, ['DB_HOST', 'API_KEY']);
    const rotated = new EnvFileRepository(db, OTHER_SECRET);
    expect(rotated.list(projectId)[0]?.readable).toBe(false);
    expect(rotated.readAll(projectId)).toEqual([{ path: '.env', unreadable: true }]);
  });

  it('marks a file unreadable when a ciphertext byte is altered', () => {
    const { db, repo, projectId } = setup();
    repo.upsert(projectId, '.env', CONTENT, ['DB_HOST', 'API_KEY']);
    const row = db.prepare('SELECT ciphertext FROM project_env_files').get() as {
      ciphertext: Uint8Array;
    };
    const tampered = Buffer.from(row.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    db.prepare('UPDATE project_env_files SET ciphertext = ?').run(tampered);

    expect(repo.list(projectId)[0]?.readable).toBe(false);
    expect(repo.readAll(projectId)).toEqual([{ path: '.env', unreadable: true }]);
  });

  it('marks a file unreadable when its rel_path or project is changed in the database (AAD)', () => {
    const { db, repo, projectId } = setup();
    repo.upsert(projectId, '.env', CONTENT, ['DB_HOST', 'API_KEY']);
    db.prepare("UPDATE project_env_files SET rel_path = '.env.local'").run();
    expect(repo.readAll(projectId)).toEqual([{ path: '.env.local', unreadable: true }]);

    const other = addProject(db, 'q');
    db.prepare("UPDATE project_env_files SET rel_path = '.env', project_id = ?").run(other);
    expect(repo.readAll(other)).toEqual([{ path: '.env', unreadable: true }]);
  });

  it('never stores the content in clear, in rows or in the database files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'panel-env-db-'));
    const db = openDatabase(join(dir, 'panel.db'));
    const repo = new EnvFileRepository(db, SECRET);
    const projectId = addProject(db);
    repo.upsert(projectId, '.env', CONTENT, ['DB_HOST', 'API_KEY']);
    repo.upsert(projectId, 'backend/.env', `OTHER=${SENTINEL}\n`, ['OTHER']);

    const rows = db.prepare('SELECT * FROM project_env_files').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      for (const value of Object.values(row)) {
        const text =
          value instanceof Uint8Array ? Buffer.from(value).toString('latin1') : String(value);
        expect(text).not.toContain(SENTINEL);
      }
    }

    // The WAL file may hold the pages before a checkpoint: scan every file of the database.
    db.close();
    for (const file of readdirSync(dir)) {
      expect(readFileSync(join(dir, file)).toString('latin1')).not.toContain(SENTINEL);
    }
  });
});
