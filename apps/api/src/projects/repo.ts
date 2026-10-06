import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULT_MODELS,
  DEFAULT_PROVIDER,
  MODEL_CATALOG,
  type ModelProvider,
  type ModelSelection,
  type KyroInitPending,
  type Project,
  type ProjectStatus,
} from '@agents-panel/shared';
import type { BashExtras } from '../agent/permissions.js';
import type { Db } from '../db/index.js';

const execFileAsync = promisify(execFile);

interface ProjectRow {
  id: number;
  name: string;
  repo_path: string;
  base_branch: string;
  setup_command: string | null;
  validate_command: string | null;
  display_name: string | null;
  repo_url: string | null;
  status: ProjectStatus;
  status_detail: string | null;
  provider: ModelProvider | null;
  thinker_model: string | null;
  executor_model: string | null;
}

const KYRO_INIT_BRANCH = 'chore/kyro-init';

function hasRef(repoPath: string, ref: string): boolean {
  try {
    execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', ref], {
      stdio: 'ignore',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The init branch is waiting when the clone has no Kyro but still has `chore/kyro-init` (worktree
 * branches live in the base clone's refs). Local refs only: listing projects never hits the network.
 */
export function pendingKyroInit(repoPath: string, repoUrl: string | null): KyroInitPending | null {
  if (!hasRef(repoPath, `refs/heads/${KYRO_INIT_BRANCH}`)) return null;
  return {
    branch: KYRO_INIT_BRANCH,
    pushed: hasRef(repoPath, `refs/remotes/origin/${KYRO_INIT_BRANCH}`),
    prUrl: repoUrl === null ? null : `${repoUrl}/pull/new/${KYRO_INIT_BRANCH}`,
  };
}

function toProject(row: ProjectRow): Project {
  const hasKyro = existsSync(join(row.repo_path, '.agents', 'kyro'));
  return {
    id: row.id,
    name: row.name,
    repoPath: row.repo_path,
    baseBranch: row.base_branch,
    setupCommand: row.setup_command,
    validateCommand: row.validate_command,
    displayName: row.display_name,
    repoUrl: row.repo_url,
    status: row.status,
    statusDetail: row.status_detail,
    hasKyro,
    kyroInit: hasKyro ? null : pendingKyroInit(row.repo_path, row.repo_url),
    // A ready project only carries a detail when Kyro setup failed after registering.
    kyroWarning: row.status === 'ready' ? row.status_detail : null,
    models: {
      provider: row.provider ?? DEFAULT_PROVIDER,
      thinker: row.thinker_model ?? DEFAULT_MODELS.thinker,
      executor: row.executor_model ?? DEFAULT_MODELS.executor,
    },
  };
}

export class ProjectError extends Error {
  override readonly name: string = 'ProjectError';
}

/** The request clashes with existing state (duplicate project, folder owned by another repo): HTTP 409. */
export class ProjectConflictError extends ProjectError {
  override readonly name = 'ProjectConflictError';
}

export class ProjectNotFoundError extends ProjectError {
  override readonly name = 'ProjectNotFoundError';
}

/** Internal project names are kebab-case: they end up in paths and worktree branches. */
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;

/** A model or provider outside the catalog: HTTP 400. */
export class InvalidModelError extends ProjectError {
  override readonly name = 'InvalidModelError';
}

/** Throws unless the provider is known and both models belong to its catalog. */
export function validateModels(
  provider: string,
  thinker: string,
  executor: string,
): ModelSelection {
  if (!Object.hasOwn(MODEL_CATALOG, provider)) {
    throw new InvalidModelError(`Proveedor desconocido: ${provider}`);
  }
  const known = MODEL_CATALOG[provider as ModelProvider];
  for (const model of [thinker, executor]) {
    if (!known.includes(model)) {
      throw new InvalidModelError(`Modelo fuera del catálogo de ${provider}: ${model}`);
    }
  }
  return { provider: provider as ModelProvider, thinker, executor };
}

export interface GithubProjectInput {
  name: string;
  displayName: string | null;
  repoUrl: string;
  repoPath: string;
  baseBranch: string;
  setupCommand: string | null;
  status: ProjectStatus;
  statusDetail: string | null;
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args]);
  return stdout.trim();
}

export class ProjectRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Removes the project with its chats (events cascade) and encrypted .env files in one
   * transaction. Files on disk are the caller's business.
   */
  deleteWithDependents(id: number): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM project_env_files WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM chats WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  list(): Project[] {
    return (
      this.db.prepare('SELECT * FROM projects ORDER BY name').all() as unknown as ProjectRow[]
    ).map(toProject);
  }

  findById(id: number): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      ProjectRow | undefined;
    return row ? toProject(row) : undefined;
  }

  findByName(name: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as
      ProjectRow | undefined;
    return row ? toProject(row) : undefined;
  }

  /** GitHub names are case-insensitive, so the canonical URL is compared lowercased. */
  findByRepoUrl(repoUrl: string): Project | undefined {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE lower(repo_url) = lower(?)')
      .get(repoUrl) as ProjectRow | undefined;
    return row ? toProject(row) : undefined;
  }

  listByStatus(status: ProjectStatus): Project[] {
    return (
      this.db
        .prepare('SELECT * FROM projects WHERE status = ? ORDER BY name')
        .all(status) as unknown as ProjectRow[]
    ).map(toProject);
  }

  /** Inserts a project coming from GitHub; the caller already validated everything. */
  insertGithub(input: GithubProjectInput): Project {
    try {
      const result = this.db
        .prepare(
          `INSERT INTO projects
            (name, display_name, repo_url, repo_path, base_branch, setup_command, status, status_detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.name,
          input.displayName,
          input.repoUrl,
          input.repoPath,
          input.baseBranch,
          input.setupCommand,
          input.status,
          input.statusDetail,
          this.now(),
        );
      const project = this.findById(Number(result.lastInsertRowid));
      if (!project) throw new ProjectError('Project insert failed');
      return project;
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) {
        // The repo_url index fires when the same repo comes in under another name.
        const byRepo = error.message.includes('projects_repo_url_unique');
        throw new ProjectConflictError(
          `El proyecto ya existe: ${byRepo ? input.repoUrl : input.name}`,
        );
      }
      throw error;
    }
  }

  setStatus(
    id: number,
    status: ProjectStatus,
    statusDetail: string | null,
    baseBranch?: string,
  ): void {
    if (baseBranch === undefined) {
      this.db
        .prepare('UPDATE projects SET status = ?, status_detail = ? WHERE id = ?')
        .run(status, statusDetail, id);
    } else {
      this.db
        .prepare('UPDATE projects SET status = ?, status_detail = ?, base_branch = ? WHERE id = ?')
        .run(status, statusDetail, baseBranch, id);
    }
  }

  updateFields(
    id: number,
    fields: {
      displayName?: string | null;
      baseBranch?: string;
      setupCommand?: string | null;
      validateCommand?: string | null;
    },
  ): void {
    if (fields.displayName !== undefined) {
      this.db
        .prepare('UPDATE projects SET display_name = ? WHERE id = ?')
        .run(fields.displayName, id);
    }
    if (fields.baseBranch !== undefined) {
      this.db
        .prepare('UPDATE projects SET base_branch = ? WHERE id = ?')
        .run(fields.baseBranch, id);
    }
    if (fields.setupCommand !== undefined) {
      this.db
        .prepare('UPDATE projects SET setup_command = ? WHERE id = ?')
        .run(fields.setupCommand, id);
    }
    if (fields.validateCommand !== undefined) {
      this.db
        .prepare('UPDATE projects SET validate_command = ? WHERE id = ?')
        .run(fields.validateCommand, id);
    }
  }

  setModels(id: number, models: ModelSelection): void {
    this.db
      .prepare(
        'UPDATE projects SET provider = ?, thinker_model = ?, executor_model = ? WHERE id = ?',
      )
      .run(models.provider, models.thinker, models.executor, id);
  }

  /** The project's Bash additions; unreadable stored data counts as none (the safe side). */
  getBashExtras(id: number): BashExtras {
    const row = this.db
      .prepare('SELECT allowed_commands, allowed_hosts FROM projects WHERE id = ?')
      .get(id) as { allowed_commands: string; allowed_hosts: string } | undefined;
    const list = (raw: string | undefined): string[] => {
      try {
        const parsed: unknown = JSON.parse(raw ?? '[]');
        return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
          ? parsed
          : [];
      } catch {
        return [];
      }
    };
    return { commands: list(row?.allowed_commands), hosts: list(row?.allowed_hosts) };
  }

  setBashExtras(id: number, extras: BashExtras): void {
    this.db
      .prepare('UPDATE projects SET allowed_commands = ?, allowed_hosts = ? WHERE id = ?')
      .run(JSON.stringify(extras.commands), JSON.stringify(extras.hosts), id);
  }

  /** Registers a project after checking the path is a git repo and the base branch exists. */
  async add(input: {
    name: string;
    repoPath: string;
    baseBranch: string;
    setupCommand?: string | undefined;
  }): Promise<Project> {
    if (!PROJECT_NAME_RE.test(input.name)) {
      throw new ProjectError('Project name must be kebab-case (max 50 characters)');
    }
    let root: string;
    try {
      root = await git(input.repoPath, ['rev-parse', '--show-toplevel']);
    } catch {
      throw new ProjectError(`Not a git repository: ${input.repoPath}`);
    }
    try {
      await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${input.baseBranch}`]);
    } catch {
      throw new ProjectError(`Base branch not found: ${input.baseBranch}`);
    }
    try {
      const result = this.db
        .prepare(
          'INSERT INTO projects (name, repo_path, base_branch, setup_command, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(input.name, root, input.baseBranch, input.setupCommand ?? null, this.now());
      const project = this.findById(Number(result.lastInsertRowid));
      if (!project) throw new ProjectError('Project insert failed');
      return project;
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) {
        throw new ProjectError(`El proyecto ya existe: ${input.name}`);
      }
      throw error;
    }
  }
}
