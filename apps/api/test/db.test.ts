import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir, tmpdir } from 'node:os';
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

  it('migrates an old database keeping its project as ready', () => {
    const dir = mkdtempSync(join(tmpdir(), 'panel-db-'));
    dirs.push(dir);
    const db = new DatabaseSync(join(dir, 'old.sqlite'));
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations.slice(0, 3));
    db.prepare(
      'INSERT INTO projects (name, repo_path, base_branch, setup_command, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('novagent', '/home/ubuntu/proyectos/novagent', 'dev', 'bash scripts/panel-setup.sh', 1);
    expect(runMigrations(db, migrations.slice(0, 4))).toEqual([4]);
    expect(runMigrations(db)).toEqual([5]);
    const row = db.prepare('SELECT * FROM projects').get();
    expect(row).toMatchObject({
      name: 'novagent',
      repo_path: '/home/ubuntu/proyectos/novagent',
      base_branch: 'dev',
      setup_command: 'bash scripts/panel-setup.sh',
      display_name: null,
      repo_url: null,
      status: 'ready',
      status_detail: null,
    });
    expect(runMigrations(db)).toEqual([]);
  });

  it('adds the unique repo_url index: no-op twice, null urls and distinct urls allowed', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, migrations.slice(0, 4));
    const insert = db.prepare(
      'INSERT INTO projects (name, repo_path, base_branch, repo_url, created_at) VALUES (?, ?, ?, ?, 1)',
    );
    insert.run('a', '/a', 'dev', null);
    insert.run('b', '/b', 'dev', null);
    insert.run('c', '/c', 'dev', 'https://github.com/o/c');
    insert.run('d', '/d', 'dev', 'https://github.com/o/d');
    expect(runMigrations(db)).toEqual([5]);
    expect(runMigrations(db)).toEqual([]);
    expect(() => insert.run('e', '/e', 'dev', 'https://github.com/O/C')).toThrow(/UNIQUE/);
    expect(db.prepare('SELECT count(*) AS n FROM projects').get()).toEqual({ n: 4 });
  });

  it('fails with a clear message, and deletes nothing, when repo_url is already duplicated', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, migrations.slice(0, 4));
    const insert = db.prepare(
      'INSERT INTO projects (name, repo_path, base_branch, repo_url, created_at) VALUES (?, ?, ?, ?, 1)',
    );
    insert.run('a', '/a', 'dev', 'https://github.com/o/x');
    insert.run('b', '/b', 'dev', 'https://github.com/O/X');
    expect(() => runMigrations(db)).toThrow(/mismo repo \(https:\/\/github.com\/o\/x\)/);
    expect(db.prepare('SELECT count(*) AS n FROM projects').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT max(version) AS v FROM schema_migrations').get()).toEqual({ v: 4 });
  });

  it('creates project_env_files and maintenance_runs with their constraints', () => {
    const db = tempDb();
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r['name']);
    expect(names).toContain('maintenance_runs');
    db.prepare(
      "INSERT INTO projects (name, repo_path, base_branch, created_at) VALUES ('p', '/x', 'dev', 1)",
    ).run();
    const projectId = Number(db.prepare('SELECT id FROM projects').get()?.['id']);
    const insert = db.prepare(
      'INSERT INTO project_env_files (project_id, rel_path, ciphertext, iv, tag, key_names, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const blob = new Uint8Array([1]);
    insert.run(projectId, '.env', blob, blob, blob, '["A"]', 1);
    expect(() => insert.run(projectId, '.env', blob, blob, blob, '["A"]', 2)).toThrow(/UNIQUE/);
    expect(() => db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)).toThrow(
      /FOREIGN KEY/,
    );
    expect(() =>
      db.prepare("UPDATE projects SET status = 'bogus' WHERE id = ?").run(projectId),
    ).toThrow(/CHECK/);
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
    expect(config.projectsDir).toBe(join(homedir(), 'proyectos'));
    expect(config.minFreeDiskGb).toBe(10);
  });

  it('reads PANEL_PROJECTS_DIR and expands ~', () => {
    const env = { ...base, PANEL_SECRET_KEY: 'k'.repeat(32) };
    expect(loadConfig({ ...env, PANEL_PROJECTS_DIR: '~/repos' }).projectsDir).toBe(
      join(homedir(), 'repos'),
    );
    expect(loadConfig({ ...env, PANEL_PROJECTS_DIR: '/srv/p' }).projectsDir).toBe('/srv/p');
  });

  it.each(['0', 'abc', '-5', '1.5'])('rejects PANEL_MIN_FREE_DISK_GB=%s', (value) => {
    const env = { ...base, PANEL_SECRET_KEY: 'k'.repeat(32), PANEL_MIN_FREE_DISK_GB: value };
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });
});
