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
    expect(runMigrations(db)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
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
    expect(runMigrations(db)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(runMigrations(db)).toEqual([]);
    expect(() => insert.run('e', '/e', 'dev', 'https://github.com/O/C')).toThrow(/UNIQUE/);
    expect(db.prepare('SELECT count(*) AS n FROM projects').get()).toEqual({ n: 4 });
  });

  it('rebuilds chats for the direct kind keeping chats and their events', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations.slice(0, 5));
    db.prepare(
      "INSERT INTO projects (name, repo_path, base_branch, created_at) VALUES ('p', '/x', 'dev', 1)",
    ).run();
    db.prepare(
      "INSERT INTO chats (project_id, kind, slug, title, worktree_path, branch, status, created_at, updated_at) VALUES (1, 'work', 's', 't', '/w', 'b', 'idle', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO chat_events (chat_id, seq, type, payload, created_at) VALUES (1, 1, 'x', '{}', 1)",
    ).run();
    expect(runMigrations(db)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(db.prepare('SELECT kind, slug FROM chats').all()).toEqual([{ kind: 'work', slug: 's' }]);
    expect(db.prepare('SELECT count(*) AS n FROM chat_events').get()).toEqual({ n: 1 });
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    db.prepare(
      "INSERT INTO chats (project_id, kind, slug, title, worktree_path, branch, status, created_at, updated_at) VALUES (1, 'direct', 'd', 't', '/w2', 'b2', 'idle', 1, 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO chats (project_id, kind, slug, title, worktree_path, branch, status, created_at, updated_at) VALUES (1, 'otro', 'e', 't', '/w3', 'b3', 'idle', 1, 1)",
        )
        .run(),
    ).toThrow(/CHECK/);
    db.prepare('DELETE FROM chats WHERE id = 1').run();
    expect(db.prepare('SELECT count(*) AS n FROM chat_events').get()).toEqual({ n: 0 });
  });

  it('applies migration 7 over 1-6 with a clean foreign_key_check and no data lost', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations.slice(0, 6));
    db.prepare(
      "INSERT INTO projects (name, repo_path, base_branch, created_at) VALUES ('p', '/x', 'dev', 1)",
    ).run();
    db.prepare(
      "INSERT INTO chats (project_id, kind, slug, title, worktree_path, branch, status, created_at, updated_at) VALUES (1, 'work', 's', 't', '/w', 'b', 'idle', 1, 1)",
    ).run();
    expect(runMigrations(db)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM chats').get()).toEqual({ n: 1 });
    const insert = db.prepare(
      "INSERT INTO pending_questions (chat_id, tool_use_id, questions, status, created_at) VALUES (?, ?, '[]', ?, 1)",
    );
    insert.run(1, 't1', 'pending');
    expect(() => insert.run(1, 't1', 'pending')).toThrow(/UNIQUE/);
    expect(() => insert.run(1, 't2', 'other')).toThrow(/CHECK/);
    expect(() => insert.run(2, 't3', 'pending')).toThrow(/FOREIGN KEY/);
  });

  it('migration 8 fills existing chats with the default models and leaves projects unconfigured', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations.slice(0, 7));
    db.prepare(
      "INSERT INTO projects (name, repo_path, base_branch, created_at) VALUES ('p', '/x', 'dev', 1)",
    ).run();
    db.prepare(
      "INSERT INTO chats (project_id, kind, slug, title, worktree_path, branch, status, created_at, updated_at) VALUES (1, 'work', 's', 't', '/w', 'b', 'idle', 1, 1)",
    ).run();
    expect(runMigrations(db)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(db.prepare('SELECT provider, thinker_model, executor_model FROM chats').get()).toEqual({
      provider: 'claude',
      thinker_model: 'claude-opus-5-5',
      executor_model: 'claude-sonnet-5-5',
    });
    expect(
      db.prepare('SELECT provider, thinker_model, executor_model FROM projects').get(),
    ).toEqual({ provider: null, thinker_model: null, executor_model: null });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('migration 10 creates worktree_state and worktree_transitions with cascade and actor checks', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations.slice(0, 9));
    db.prepare(
      "INSERT INTO projects (name, repo_path, base_branch, created_at) VALUES ('p', '/x', 'dev', 1)",
    ).run();
    db.prepare(
      "INSERT INTO chats (project_id, kind, slug, title, worktree_path, branch, status, created_at, updated_at) VALUES (1, 'work', 's', 't', '/w', 'b', 'idle', 1, 1)",
    ).run();
    expect(runMigrations(db)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.prepare(
      "INSERT INTO worktree_state (chat_id, state, actor, since) VALUES (1, 'qa', 'pilot', 1)",
    ).run();
    db.prepare(
      "INSERT INTO worktree_transitions (chat_id, to_state, actor, created_at) VALUES (1, 'qa', 'pilot', 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO worktree_state (chat_id, state, actor, since) VALUES (2, 'qa', 'pilot', 1)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    db.prepare('DELETE FROM chats WHERE id = 1').run();
    expect(db.prepare('SELECT count(*) AS n FROM worktree_state').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM worktree_transitions').get()).toEqual({ n: 0 });
  });

  it('migration 11 gives existing projects empty permission lists', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, migrations.slice(0, 10));
    db.prepare(
      "INSERT INTO projects (name, repo_path, base_branch, created_at) VALUES ('p', '/x', 'dev', 1)",
    ).run();
    expect(runMigrations(db)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(db.prepare('SELECT allowed_commands, allowed_hosts FROM projects').get()).toEqual({
      allowed_commands: '[]',
      allowed_hosts: '[]',
    });
  });

  it('migration 12 creates autopilot_runs and leaves existing sessions as manual', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations.slice(0, 11));
    db.prepare(
      "INSERT INTO projects (name, repo_path, base_branch, created_at) VALUES ('p', '/x', 'dev', 1)",
    ).run();
    db.prepare(
      "INSERT INTO chats (project_id, kind, slug, title, worktree_path, branch, status, created_at, updated_at) VALUES (1, 'work', 's', 't', '/w', 'b', 'idle', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO agent_sessions (chat_id, role, provider, model, started_at) VALUES (1, 'executor', 'claude', 'm', 1)",
    ).run();
    expect(runMigrations(db)).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('SELECT step, policy_version FROM agent_sessions').get()).toEqual({
      step: 'manual',
      policy_version: null,
    });
    expect(
      (db.prepare('PRAGMA table_info(autopilot_runs)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    ).toEqual([
      'chat_id',
      'status',
      'step',
      'sprint_n',
      'sessions_in_sprint',
      'last_fingerprint',
      'stop_reason',
      'retry_at',
      'policy_version',
      'created_at',
      'updated_at',
      'seed_path',
      'phase',
      'pr_urls',
    ]);
    db.prepare(
      "INSERT INTO autopilot_runs (chat_id, status, created_at, updated_at) VALUES (1, 'active', 1, 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO autopilot_runs (chat_id, status, created_at, updated_at) VALUES (1, 'x', 1, 1)",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db.prepare("UPDATE autopilot_runs SET status = 'bogus' WHERE chat_id = 1").run(),
    ).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE agent_sessions SET step = 'bogus' WHERE id = 1").run()).toThrow(
      /CHECK/,
    );
    db.prepare('DELETE FROM chats WHERE id = 1').run();
    expect(db.prepare('SELECT count(*) AS n FROM autopilot_runs').get()).toEqual({ n: 0 });
  });

  it('migration 13 admits kind idea and keeps the chats, their ids, models and children', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations.slice(0, 12));
    db.prepare(
      "INSERT INTO projects (name, repo_path, base_branch, created_at) VALUES ('p', '/x', 'dev', 1)",
    ).run();
    for (const [id, kind] of [
      [1, 'scope'],
      [2, 'work'],
      [3, 'direct'],
    ] as const) {
      db.prepare(
        `INSERT INTO chats (id, project_id, kind, slug, title, worktree_path, branch, status, created_at, updated_at, thinker_model)
         VALUES (${String(id)}, 1, '${kind}', 's${String(id)}', 't', '/w', 'b', 'idle', 1, 1, 'modelo-x')`,
      ).run();
    }
    db.prepare(
      "INSERT INTO agent_sessions (chat_id, role, provider, model, started_at) VALUES (2, 'executor', 'claude', 'm', 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO chats (project_id, kind, slug, title, worktree_path, branch, status, created_at, updated_at) VALUES (1, 'idea', 'i', 't', '/w', 'b', 'idle', 1, 1)",
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(runMigrations(db)).toEqual([13, 14, 15, 16, 17, 18, 19]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('SELECT id, kind, thinker_model FROM chats ORDER BY id').all()).toEqual([
      { id: 1, kind: 'scope', thinker_model: 'modelo-x' },
      { id: 2, kind: 'work', thinker_model: 'modelo-x' },
      { id: 3, kind: 'direct', thinker_model: 'modelo-x' },
    ]);
    db.prepare(
      "INSERT INTO chats (project_id, kind, slug, title, worktree_path, branch, status, created_at, updated_at) VALUES (1, 'idea', 'i', 't', '/w', 'b', 'idle', 1, 1)",
    ).run();
    expect(db.prepare('SELECT count(*) AS n FROM agent_sessions').get()).toEqual({ n: 1 });
    expect(() =>
      db
        .prepare(
          "INSERT INTO chats (project_id, kind, slug, title, worktree_path, branch, status, created_at, updated_at) VALUES (1, 'otro', 'o', 't', '/w', 'b', 'idle', 1, 1)",
        )
        .run(),
    ).toThrow(/CHECK/);
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
