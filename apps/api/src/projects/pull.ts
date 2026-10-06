import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentManager } from '../agent/manager.js';
import type { PullBaseResult, RepoPullResult } from '@agents-panel/shared';
import { PullRejectedError, pullFastForward } from './git.js';
import { ProjectConflictError, ProjectNotFoundError, type ProjectRepository } from './repo.js';
import type { ProjectRepoRepository } from './repos-repo.js';

export interface PullServiceDeps {
  projects: Pick<ProjectRepository, 'findById'>;
  manager: Pick<AgentManager, 'inMaintenance'>;
  /** Repos of each project; without it (or without rows) only the root is updated. */
  projectRepos?: Pick<ProjectRepoRepository, 'listByProject'>;
  pull?: typeof pullFastForward;
}

/** Updates a project's base clone from GitHub so new worktrees start from what is already pushed. */
export class PullService {
  private readonly pull: typeof pullFastForward;
  private readonly running = new Set<number>();

  constructor(private readonly deps: PullServiceDeps) {
    this.pull = deps.pull ?? pullFastForward;
  }

  /**
   * Fast-forwards every repo of the project (root first) from its own base. A repo that cannot be
   * updated (local changes, divergence, missing folder) gets an `error` and never stops the rest.
   * The response keeps the root's result at the top level (what the web already reads) plus
   * `repos`; when the root itself fails its error is thrown after the other repos were updated.
   */
  async pullBase(projectId: number): Promise<PullBaseResult> {
    const project = this.deps.projects.findById(projectId);
    if (!project) throw new ProjectNotFoundError(`Project not found: ${String(projectId)}`);
    if (project.status !== 'ready') {
      throw new ProjectConflictError(`El proyecto todavía no está listo: ${project.status}`);
    }
    // The Kyro update script runs `kyro install` inside every project folder.
    if (this.deps.manager.inMaintenance) {
      throw new ProjectConflictError('Hay una actualización de Kyro en curso');
    }
    if (this.running.has(project.id)) {
      throw new ProjectConflictError('Ya hay una actualización de este proyecto en curso');
    }
    this.running.add(project.id);
    try {
      const stored = this.deps.projectRepos?.listByProject(project.id) ?? [];
      const targets = stored.some((repo) => repo.path === '.')
        ? stored
        : [{ path: '.', baseBranch: project.baseBranch }, ...stored];
      const repos: RepoPullResult[] = [];
      let rootError: Error | undefined;
      for (const target of targets) {
        const folder = target.path === '.' ? project.repoPath : join(project.repoPath, target.path);
        try {
          if (!existsSync(folder)) throw new PullRejectedError(`Falta la carpeta ${target.path}`);
          const result = await this.pull(folder, target.baseBranch);
          repos.push({ path: target.path, baseBranch: target.baseBranch, result, error: null });
        } catch (error) {
          if (target.path === '.')
            rootError = error instanceof Error ? error : new Error(String(error));
          repos.push({
            path: target.path,
            baseBranch: target.baseBranch,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (rootError !== undefined) throw rootError;
      const root = repos.find((repo) => repo.path === '.')?.result;
      if (!root) throw new ProjectConflictError('El proyecto no tiene repo raíz');
      return { ...root, repos };
    } finally {
      this.running.delete(project.id);
    }
  }
}
