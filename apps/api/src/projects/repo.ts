import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Project } from '@agents-panel/shared';
import type { Db } from '../db/index.js';

const execFileAsync = promisify(execFile);

interface ProjectRow {
  id: number;
  name: string;
  repo_path: string;
  base_branch: string;
  setup_command: string | null;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    repoPath: row.repo_path,
    baseBranch: row.base_branch,
    setupCommand: row.setup_command,
  };
}

export class ProjectError extends Error {
  override readonly name = 'ProjectError';
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

  /** Registers a project after checking the path is a git repo and the base branch exists. */
  async add(input: {
    name: string;
    repoPath: string;
    baseBranch: string;
    setupCommand?: string | undefined;
  }): Promise<Project> {
    if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(input.name)) {
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
        throw new ProjectError(`Project already exists: ${input.name}`);
      }
      throw error;
    }
  }
}
