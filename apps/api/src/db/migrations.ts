import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  /** Runs inside the transaction before `sql`; throw to abort with a clear message. */
  readonly check?: (db: DatabaseSync) => void;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'auth',
    sql: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE user_totp (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        secret_encrypted TEXT NOT NULL,
        confirmed INTEGER NOT NULL DEFAULT 0,
        last_used_step INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE recovery_codes (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        used_at INTEGER
      );
      CREATE INDEX recovery_codes_user ON recovery_codes(user_id);
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_token TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'full',
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX sessions_user ON sessions(user_id);
      CREATE TABLE login_attempts (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL,
        ip TEXT NOT NULL,
        success INTEGER NOT NULL,
        reason TEXT,
        at INTEGER NOT NULL
      );
      CREATE INDEX login_attempts_ip_at ON login_attempts(ip, at);
      CREATE INDEX login_attempts_username_at ON login_attempts(username, at);
    `,
  },
  {
    version: 2,
    name: 'login_attempts_audit',
    sql: `
      ALTER TABLE login_attempts ADD COLUMN user_agent TEXT;
      ALTER TABLE login_attempts ADD COLUMN step TEXT NOT NULL DEFAULT 'password';
    `,
  },
  {
    version: 3,
    name: 'projects_and_chats',
    sql: `
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        repo_path TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        setup_command TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE chats (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id),
        kind TEXT NOT NULL CHECK (kind IN ('scope', 'work')),
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch TEXT NOT NULL,
        sdk_session_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'idle', 'error', 'interrupted', 'cancelled')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (project_id, slug)
      );
      CREATE TABLE chat_events (
        id INTEGER PRIMARY KEY,
        chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (chat_id, seq)
      );
    `,
  },
  {
    version: 4,
    name: 'projects_from_github_env_files_maintenance',
    sql: `
      ALTER TABLE projects ADD COLUMN display_name TEXT;
      ALTER TABLE projects ADD COLUMN repo_url TEXT;
      ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('cloning', 'ready', 'error'));
      ALTER TABLE projects ADD COLUMN status_detail TEXT;
      CREATE TABLE project_env_files (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id),
        rel_path TEXT NOT NULL,
        ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        tag BLOB NOT NULL,
        key_names TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (project_id, rel_path)
      );
      CREATE TABLE maintenance_runs (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        from_version TEXT,
        to_version TEXT,
        status TEXT NOT NULL,
        output TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
    `,
  },
  {
    version: 5,
    name: 'projects_repo_url_unique',
    // Never deletes rows: duplicates must be resolved by hand before the index can exist.
    check: (db) => {
      const duplicates = db
        .prepare(
          `SELECT lower(repo_url) AS repo_url, count(*) AS total FROM projects
           WHERE repo_url IS NOT NULL GROUP BY lower(repo_url) HAVING count(*) > 1`,
        )
        .all();
      if (duplicates.length > 0) {
        const urls = duplicates.map((row) => String(row['repo_url'])).join(', ');
        throw new Error(
          `No se puede crear el índice único de repo_url: hay proyectos con el mismo repo (${urls}). ` +
            'Resolverlo a mano y volver a arrancar.',
        );
      }
    },
    sql: 'CREATE UNIQUE INDEX projects_repo_url_unique ON projects(lower(repo_url)) WHERE repo_url IS NOT NULL;',
  },
];

/** Applies pending migrations in order, each in its own transaction. Safe to run repeatedly. */
export function runMigrations(db: DatabaseSync, list: readonly Migration[] = migrations): number[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
  );
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => Number(row['version'])),
  );
  const ran: number[] = [];
  for (const migration of [...list].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN');
    try {
      migration.check?.(db);
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        Date.now(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    ran.push(migration.version);
  }
  return ran;
}
