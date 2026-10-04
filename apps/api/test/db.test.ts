import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { migrations, runMigrations } from '../src/db/migrations.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'panel-db-'));
  dirs.push(dir);
  return openDatabase(join(dir, 'panel.sqlite'));
}

describe('migrations', () => {
  it('is idempotent: the second run changes nothing', () => {
    const db = tempDb();
    const before = db.prepare('SELECT * FROM schema_migrations').all();
    expect(runMigrations(db)).toEqual([]);
    expect(db.prepare('SELECT * FROM schema_migrations').all()).toEqual(before);
    expect(before).toHaveLength(migrations.length);
  });

  it('creates the auth tables', () => {
    const names = tempDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r['name']);
    for (const table of ['users', 'user_totp', 'recovery_codes', 'sessions', 'login_attempts']) {
      expect(names).toContain(table);
    }
  });

  it('enables WAL and foreign keys', () => {
    const db = tempDb();
    expect(db.prepare('PRAGMA journal_mode').get()?.['journal_mode']).toBe('wal');
    expect(db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys']).toBe(1);
  });
});

describe('loadConfig', () => {
  const base = { PANEL_ORIGIN: 'http://localhost:4200', PANEL_DATA_DIR: '/tmp/x' };

  it('fails when PANEL_SECRET_KEY is missing', () => {
    expect(() => loadConfig(base)).toThrow(ConfigError);
  });

  it('fails when the key is too short without printing it', () => {
    const secret = 'short-secret-value';
    try {
      loadConfig({ ...base, PANEL_SECRET_KEY: secret });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).toContain('PANEL_SECRET_KEY');
    }
  });

  it('accepts a valid environment and applies defaults', () => {
    const config = loadConfig({ ...base, PANEL_SECRET_KEY: 'k'.repeat(32) });
    expect(config.origin).toBe('http://localhost:4200');
    expect(config.sessionIdleTtlSeconds).toBe(1800);
    expect(config.sessionAbsoluteTtlSeconds).toBe(43200);
  });
});
