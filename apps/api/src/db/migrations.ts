import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  /** Runs inside the transaction before `sql`; throw to abort with a clear message. */
  readonly check?: (db: DatabaseSync) => void;
  /**
   * Rebuilds a table other tables point to: foreign keys are switched off outside the transaction
   * (the pragma is a no-op inside one), checked before commit and switched back on.
   */
  readonly rebuildsTable?: boolean;
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
  {
    version: 6,
    name: 'chats_kind_direct',
    // SQLite cannot alter a CHECK, so chats is rebuilt; chat_events keeps pointing at it by name.
    rebuildsTable: true,
    sql: `
      CREATE TABLE chats_new (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id),
        kind TEXT NOT NULL CHECK (kind IN ('scope', 'work', 'direct')),
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
      INSERT INTO chats_new SELECT id, project_id, kind, slug, title, worktree_path, branch,
        sdk_session_id, status, created_at, updated_at FROM chats;
      DROP TABLE chats;
      ALTER TABLE chats_new RENAME TO chats;
    `,
  },
  {
    version: 7,
    name: 'pending_questions',
    // An answer can never exist without who gave it and when (R2): the CHECKs make that structural.
    sql: `
      CREATE TABLE pending_questions (
        id INTEGER PRIMARY KEY,
        chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        tool_use_id TEXT NOT NULL,
        questions TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'cancelled')),
        answer TEXT,
        answered_by INTEGER REFERENCES users(id),
        created_at INTEGER NOT NULL,
        answered_at INTEGER,
        UNIQUE (chat_id, tool_use_id),
        CHECK ((status = 'answered') = (answer IS NOT NULL)),
        CHECK ((status = 'answered') = (answered_by IS NOT NULL)),
        CHECK ((status = 'answered') = (answered_at IS NOT NULL))
      );
      CREATE INDEX pending_questions_chat ON pending_questions(chat_id, status);
    `,
  },
  {
    version: 8,
    name: 'models',
    // Project columns are NULL until configured (NULL = global default); chats always store the
    // resolved models, and existing rows get the defaults from the column DEFAULT.
    sql: `
      ALTER TABLE projects ADD COLUMN provider TEXT;
      ALTER TABLE projects ADD COLUMN thinker_model TEXT;
      ALTER TABLE projects ADD COLUMN executor_model TEXT;
      ALTER TABLE chats ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
      ALTER TABLE chats ADD COLUMN thinker_model TEXT NOT NULL DEFAULT 'claude-opus-5-5';
      ALTER TABLE chats ADD COLUMN executor_model TEXT NOT NULL DEFAULT 'claude-sonnet-5-5';
    `,
  },
  {
    version: 9,
    name: 'agent_sessions',
    // One row per SDK session the panel opens; the pilot counts them per sprint (sprint_n).
    sql: `
      CREATE TABLE agent_sessions (
        id INTEGER PRIMARY KEY,
        chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('thinker', 'executor')),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        sdk_session_id TEXT,
        sprint_n INTEGER,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        result TEXT
      );
      CREATE INDEX agent_sessions_chat ON agent_sessions(chat_id, started_at);
    `,
  },
  {
    version: 10,
    name: 'worktree_state',
    // State ids are validated by the repository against the shared catalog; the actor is
    // structural (R4: every transition says who did it).
    sql: `
      CREATE TABLE worktree_state (
        chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        detail TEXT,
        phase TEXT,
        sprint_current INTEGER,
        sprint_closed INTEGER,
        sprint_total INTEGER,
        task_done INTEGER,
        task_total INTEGER,
        open_debt INTEGER,
        blocked_reason TEXT,
        actor TEXT NOT NULL CHECK (actor IN ('user', 'pilot', 'agent', 'system')),
        role TEXT CHECK (role IN ('thinker', 'executor')),
        model TEXT,
        since INTEGER NOT NULL,
        previous_state TEXT
      );
      CREATE TABLE worktree_transitions (
        id INTEGER PRIMARY KEY,
        chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        from_state TEXT,
        to_state TEXT NOT NULL,
        reason TEXT,
        actor TEXT NOT NULL CHECK (actor IN ('user', 'pilot', 'agent', 'system')),
        role TEXT CHECK (role IN ('thinker', 'executor')),
        model TEXT,
        data TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX worktree_transitions_chat ON worktree_transitions(chat_id, id);
    `,
  },
  {
    version: 11,
    name: 'project_permissions',
    // JSON arrays of names; the API validates them before they are stored.
    sql: `
      ALTER TABLE projects ADD COLUMN allowed_commands TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE projects ADD COLUMN allowed_hosts TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 12,
    name: 'autopilot_runs',
    // One autopilot per scope or work; step and status are validated here because the pilot reads
    // them back after a restart. Existing sessions were all started by hand.
    sql: `
      CREATE TABLE autopilot_runs (
        chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN
          ('active', 'paused', 'off', 'stopped', 'waiting_quota', 'queued', 'finished')),
        step TEXT CHECK (step IN ('plan', 'execute', 'fix', 'close', 'manual')),
        sprint_n INTEGER,
        sessions_in_sprint INTEGER NOT NULL DEFAULT 0,
        last_fingerprint TEXT,
        stop_reason TEXT,
        retry_at INTEGER,
        policy_version INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      ALTER TABLE agent_sessions ADD COLUMN step TEXT NOT NULL DEFAULT 'manual'
        CHECK (step IN ('plan', 'execute', 'fix', 'close', 'manual'));
      ALTER TABLE agent_sessions ADD COLUMN policy_version INTEGER;
    `,
  },
  {
    version: 13,
    name: 'chats_kind_idea',
    // Same rebuild as chats_kind_direct, now with the model columns added by `models`.
    rebuildsTable: true,
    sql: `
      CREATE TABLE chats_new (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id),
        kind TEXT NOT NULL CHECK (kind IN ('scope', 'work', 'direct', 'idea')),
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch TEXT NOT NULL,
        sdk_session_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'idle', 'error', 'interrupted', 'cancelled')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        thinker_model TEXT NOT NULL DEFAULT 'claude-opus-5-5',
        executor_model TEXT NOT NULL DEFAULT 'claude-sonnet-5-5',
        UNIQUE (project_id, slug)
      );
      INSERT INTO chats_new (id, project_id, kind, slug, title, worktree_path, branch, sdk_session_id,
        status, created_at, updated_at, provider, thinker_model, executor_model)
        SELECT id, project_id, kind, slug, title, worktree_path, branch, sdk_session_id,
        status, created_at, updated_at, provider, thinker_model, executor_model FROM chats;
      DROP TABLE chats;
      ALTER TABLE chats_new RENAME TO chats;
    `,
  },
  {
    version: 14,
    name: 'pilot_step_init',
    // The step CHECKs are rebuilt to admit 'init' (the session that creates the scope of an
    // approved idea); autopilot_runs also gets seed_path, the idea document that session reads.
    rebuildsTable: true,
    sql: `
      CREATE TABLE agent_sessions_new (
        id INTEGER PRIMARY KEY,
        chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('thinker', 'executor')),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        sdk_session_id TEXT,
        sprint_n INTEGER,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        result TEXT,
        step TEXT NOT NULL DEFAULT 'manual'
          CHECK (step IN ('init', 'plan', 'execute', 'fix', 'close', 'manual')),
        policy_version INTEGER
      );
      INSERT INTO agent_sessions_new (id, chat_id, role, provider, model, sdk_session_id, sprint_n,
        started_at, ended_at, result, step, policy_version)
        SELECT id, chat_id, role, provider, model, sdk_session_id, sprint_n,
        started_at, ended_at, result, step, policy_version FROM agent_sessions;
      DROP TABLE agent_sessions;
      ALTER TABLE agent_sessions_new RENAME TO agent_sessions;
      CREATE INDEX agent_sessions_chat ON agent_sessions(chat_id, started_at);

      CREATE TABLE autopilot_runs_new (
        chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN
          ('active', 'paused', 'off', 'stopped', 'waiting_quota', 'queued', 'finished')),
        step TEXT CHECK (step IN ('init', 'plan', 'execute', 'fix', 'close', 'manual')),
        sprint_n INTEGER,
        sessions_in_sprint INTEGER NOT NULL DEFAULT 0,
        last_fingerprint TEXT,
        stop_reason TEXT,
        retry_at INTEGER,
        policy_version INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        seed_path TEXT
      );
      INSERT INTO autopilot_runs_new (chat_id, status, step, sprint_n, sessions_in_sprint,
        last_fingerprint, stop_reason, retry_at, policy_version, created_at, updated_at)
        SELECT chat_id, status, step, sprint_n, sessions_in_sprint,
        last_fingerprint, stop_reason, retry_at, policy_version, created_at, updated_at
        FROM autopilot_runs;
      DROP TABLE autopilot_runs;
      ALTER TABLE autopilot_runs_new RENAME TO autopilot_runs;
    `,
  },
  {
    version: 15,
    name: 'projects_validate_command',
    // Optional, like setup_command: what the pilot runs in the worktree before opening the PR.
    sql: 'ALTER TABLE projects ADD COLUMN validate_command TEXT;',
  },
  {
    version: 16,
    name: 'pilot_merge_phase',
    // The step CHECKs admit the merge sessions, and a run remembers its phase and PRs so a restart
    // takes the merge up again where it was.
    rebuildsTable: true,
    sql: `
      CREATE TABLE agent_sessions_new (
        id INTEGER PRIMARY KEY,
        chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('thinker', 'executor')),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        sdk_session_id TEXT,
        sprint_n INTEGER,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        result TEXT,
        step TEXT NOT NULL DEFAULT 'manual'
          CHECK (step IN ('init', 'plan', 'execute', 'fix', 'close', 'merge', 'merge_dev', 'manual')),
        policy_version INTEGER
      );
      INSERT INTO agent_sessions_new (id, chat_id, role, provider, model, sdk_session_id, sprint_n,
        started_at, ended_at, result, step, policy_version)
        SELECT id, chat_id, role, provider, model, sdk_session_id, sprint_n,
        started_at, ended_at, result, step, policy_version FROM agent_sessions;
      DROP TABLE agent_sessions;
      ALTER TABLE agent_sessions_new RENAME TO agent_sessions;
      CREATE INDEX agent_sessions_chat ON agent_sessions(chat_id, started_at);

      CREATE TABLE autopilot_runs_new (
        chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN
          ('active', 'paused', 'off', 'stopped', 'waiting_quota', 'queued', 'finished')),
        step TEXT CHECK (step IN ('init', 'plan', 'execute', 'fix', 'close', 'merge', 'merge_dev', 'manual')),
        sprint_n INTEGER,
        sessions_in_sprint INTEGER NOT NULL DEFAULT 0,
        last_fingerprint TEXT,
        stop_reason TEXT,
        retry_at INTEGER,
        policy_version INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        seed_path TEXT,
        phase TEXT CHECK (phase IS NULL OR phase IN ('merge')),
        pr_urls TEXT NOT NULL DEFAULT '[]'
      );
      INSERT INTO autopilot_runs_new (chat_id, status, step, sprint_n, sessions_in_sprint,
        last_fingerprint, stop_reason, retry_at, policy_version, created_at, updated_at, seed_path)
        SELECT chat_id, status, step, sprint_n, sessions_in_sprint,
        last_fingerprint, stop_reason, retry_at, policy_version, created_at, updated_at, seed_path
        FROM autopilot_runs;
      DROP TABLE autopilot_runs;
      ALTER TABLE autopilot_runs_new RENAME TO autopilot_runs;
    `,
  },
  {
    version: 17,
    name: 'push_subscriptions',
    // One row per browser or phone of a user; the endpoint identifies the subscription.
    sql: `
      CREATE TABLE push_subscriptions (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        name TEXT NOT NULL,
        user_agent TEXT,
        created_at INTEGER NOT NULL,
        last_success_at INTEGER
      );
      CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);
    `,
  },
  {
    version: 18,
    name: 'app_flags',
    // One-time jobs of the startup (a marker per job, so they do not run again on every start).
    sql: `
      CREATE TABLE app_flags (
        name TEXT PRIMARY KEY,
        set_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 19,
    name: 'claude_accounts',
    // Claude Code logins the panel can use. config_dir NULL is the default account (~/.claude),
    // created active; exactly one row is active (enforced by the partial unique index).
    sql: `
      CREATE TABLE claude_accounts (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        config_dir TEXT UNIQUE,
        active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX claude_accounts_one_active ON claude_accounts (active) WHERE active = 1;
      INSERT INTO claude_accounts (name, config_dir, active, created_at)
        VALUES ('Cuenta principal', NULL, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
      ALTER TABLE agent_sessions
        ADD COLUMN account_id INTEGER REFERENCES claude_accounts(id) ON DELETE SET NULL;
    `,
  },
  {
    version: 20,
    name: 'project_repos',
    // Repos of a project: the root ('.', the project's base) plus the child repos found in the
    // base clone. The path is relative and only ever comes from detection, never from the user.
    sql: `
      CREATE TABLE project_repos (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (project_id, path)
      );
      INSERT INTO project_repos (project_id, path, base_branch, created_at, updated_at)
        SELECT id, '.', base_branch, created_at, created_at FROM projects;
    `,
  },
  {
    version: 21,
    name: 'provider_usage',
    // Last observation of each usage window per account (D24, measured by account_id).
    sql: `
      CREATE TABLE provider_usage (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES claude_accounts(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider IN ('claude')),
        window TEXT NOT NULL,
        utilization REAL CHECK (utilization IS NULL OR (utilization >= 0 AND utilization <= 100)),
        status TEXT CHECK (status IS NULL OR status IN ('allowed', 'allowed_warning', 'rejected')),
        resets_at INTEGER,
        source TEXT NOT NULL CHECK (source IN ('event', 'query')),
        observed_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX provider_usage_window ON provider_usage (account_id, provider, window);
    `,
  },
  {
    version: 22,
    name: 'panel_steps',
    // Timed steps of the panel that run no AI (setup, analyze, push, merge phase steps).
    sql: `
      CREATE TABLE panel_steps (
        id INTEGER PRIMARY KEY,
        chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        result TEXT
      );
      CREATE INDEX panel_steps_chat ON panel_steps (chat_id, started_at);
    `,
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
    if (migration.rebuildsTable) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      migration.check?.(db);
      db.exec(migration.sql);
      if (migration.rebuildsTable && db.prepare('PRAGMA foreign_key_check').all().length > 0) {
        throw new Error(`La migración ${String(migration.version)} dejó claves foráneas rotas`);
      }
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        Date.now(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      if (migration.rebuildsTable) db.exec('PRAGMA foreign_keys = ON');
    }
    ran.push(migration.version);
  }
  return ran;
}
