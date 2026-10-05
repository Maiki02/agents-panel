import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { KyroBranchResult, Project } from '@agents-panel/shared';
import type { AgentManager } from '../agent/manager.js';
import type { KyroLock } from '../maintenance/lock.js';
import { createWorktree, removeWorktree, WorktreeError } from '../worktrees/create.js';
import { ProjectConflictError, ProjectNotFoundError, type ProjectRepository } from './repo.js';
import { kyroInstall, type KyroInitializer } from './service.js';

const execFileAsync = promisify(execFile);

export const KYRO_INIT_SLUG = 'kyro-init';
export const KYRO_INIT_BRANCH = 'chore/kyro-init';
const COMMIT_MESSAGE = 'chore(kyro): inicializar Kyro';
const DETAIL_MAX = 500;

/** Installing Kyro (or committing its files) failed; nothing was left behind. */
export class KyroInitError extends Error {
  override readonly name = 'KyroInitError';
}

export interface KyroBranchDeps {
  projects: Pick<ProjectRepository, 'findById'>;
  worktreesDir: string;
  /** Shared with the Kyro updater so `kyro install` and `kyro update` never overlap. */
  kyroLock: KyroLock;
  manager: Pick<AgentManager, 'inMaintenance'>;
  installer?: KyroInitializer;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args]);
  return stdout.trim();
}

function detail(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text =
    typeof stderr === 'string' && stderr.trim() !== ''
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error);
  return text.trim().slice(0, DETAIL_MAX);
}

/**
 * Adds Kyro to a project that has none, on its own branch: the files only reach new worktrees once
 * they are committed, so the install runs in a dedicated worktree and the base clone stays untouched.
 * The branch is left committed and unpushed for the user to review and merge.
 */
export class KyroBranchService {
  private readonly installer: KyroInitializer;
  /** Projects with an init in flight: a second request must not race the first one's worktree. */
  private readonly running = new Set<number>();

  constructor(private readonly deps: KyroBranchDeps) {
    this.installer = deps.installer ?? kyroInstall;
  }

  async init(projectId: number): Promise<KyroBranchResult> {
    const project = this.deps.projects.findById(projectId);
    if (!project) throw new ProjectNotFoundError(`Project not found: ${String(projectId)}`);
    this.assertCanInit(project);
    if (this.running.has(project.id)) {
      throw new ProjectConflictError('Ya hay una inicialización de Kyro en curso en este proyecto');
    }
    this.running.add(project.id);
    try {
      return await this.createBranch(project);
    } finally {
      this.running.delete(project.id);
    }
  }

  private assertCanInit(project: Project): void {
    if (project.status !== 'ready') {
      throw new ProjectConflictError(`El proyecto todavía no está listo: ${project.status}`);
    }
    if (project.hasKyro) throw new ProjectConflictError('El proyecto ya tiene Kyro');
    if (this.deps.manager.inMaintenance) {
      throw new ProjectConflictError('Hay una actualización de Kyro en curso');
    }
  }

  private async createBranch(project: Project): Promise<KyroBranchResult> {
    let worktree;
    try {
      worktree = await createWorktree(project, KYRO_INIT_SLUG, this.deps.worktreesDir, undefined, {
        branch: KYRO_INIT_BRANCH,
        skipSetup: true,
      });
    } catch (error) {
      if (error instanceof WorktreeError) {
        // A leftover branch or folder from an earlier init is a conflict, not a server error.
        throw new ProjectConflictError(error.message);
      }
      throw error;
    }
    try {
      await this.deps.kyroLock.run(() => this.installer(worktree.path));
      await git(worktree.path, ['add', '-A']);
      if ((await git(worktree.path, ['status', '--porcelain'])) === '') {
        throw new KyroInitError('kyro install no generó ningún archivo para commitear');
      }
      await git(worktree.path, ['commit', '-q', '-m', COMMIT_MESSAGE]);
      const commit = await git(worktree.path, ['rev-parse', 'HEAD']);
      return { branch: worktree.branch, path: worktree.path, commit };
    } catch (error) {
      // Nothing may outlive a failed init: drop the worktree and its branch.
      await removeWorktree(project.repoPath, worktree.path, worktree.branch);
      if (error instanceof KyroInitError) throw error;
      throw new KyroInitError(`No se pudo inicializar Kyro: ${detail(error)}`);
    }
  }
}
