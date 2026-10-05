import type { AgentManager } from '../agent/manager.js';
import type { PullResult } from '@agents-panel/shared';
import { pullFastForward } from './git.js';
import { ProjectConflictError, ProjectNotFoundError, type ProjectRepository } from './repo.js';

export interface PullServiceDeps {
  projects: Pick<ProjectRepository, 'findById'>;
  manager: Pick<AgentManager, 'inMaintenance'>;
  pull?: typeof pullFastForward;
}

/** Updates a project's base clone from GitHub so new worktrees start from what is already pushed. */
export class PullService {
  private readonly pull: typeof pullFastForward;
  private readonly running = new Set<number>();

  constructor(private readonly deps: PullServiceDeps) {
    this.pull = deps.pull ?? pullFastForward;
  }

  async pullBase(projectId: number): Promise<PullResult> {
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
      return await this.pull(project.repoPath, project.baseBranch);
    } finally {
      this.running.delete(project.id);
    }
  }
}
