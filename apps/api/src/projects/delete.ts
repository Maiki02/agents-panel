import { existsSync } from 'node:fs';
import { lstat, realpath, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { AgentManager } from '../agent/manager.js';
import type { ChatRepository } from '../chats/repo.js';
import type { Config } from '../config.js';
import { git } from './git.js';
import {
  ProjectConflictError,
  ProjectError,
  ProjectNotFoundError,
  type ProjectRepository,
} from './repo.js';
import { findUnsavedWork, type Blocker } from './safety.js';

/** The delete is refused because it would lose work or interrupt a session; nothing was touched. */
export class DeleteBlockedError extends ProjectConflictError {
  constructor(
    message: string,
    readonly blockers: Blocker[],
    readonly running: number,
  ) {
    super(message);
  }
}

/** Something failed halfway: the project is still registered, so it can be retried. */
export class DeletePartialError extends Error {
  override readonly name = 'DeletePartialError';
}

export interface DeleteResult {
  /** True when the clone folder was removed; false when it lives outside the projects directory. */
  cloneRemoved: boolean;
}

export interface ProjectDeleterDeps {
  projects: ProjectRepository;
  chats: Pick<ChatRepository, 'list'>;
  manager: Pick<AgentManager, 'inMaintenance'>;
  config: Pick<Config, 'projectsDir' | 'worktreesDir'>;
  findWork?: (repoPath: string) => Promise<Blocker[]>;
}

/** True when `target` is exactly one level below `root` (never the root, never deeper). */
function isDirectChild(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !rel.includes(sep) && resolve(root, rel) === target;
}

/**
 * Deletes a project: its worktrees, its clone, its chats and its encrypted .env files. Refuses,
 * touching nothing, while a session runs or any repo holds work that exists nowhere else. It
 * deletes the registry row last, so a failure halfway leaves a project that can be retried.
 */
export class ProjectDeleter {
  private readonly findWork: (repoPath: string) => Promise<Blocker[]>;
  private readonly running = new Set<number>();

  constructor(private readonly deps: ProjectDeleterDeps) {
    this.findWork = deps.findWork ?? findUnsavedWork;
  }

  async delete(projectId: number, typedName: string): Promise<DeleteResult> {
    const { projects, chats, manager } = this.deps;
    const project = projects.findById(projectId);
    if (!project) throw new ProjectNotFoundError(`Project not found: ${String(projectId)}`);
    const accepted = [project.name, project.displayName].filter((n): n is string => !!n);
    if (!accepted.includes(typedName.trim())) {
      throw new ProjectError('El nombre escrito no coincide con el del proyecto');
    }
    if (project.status === 'cloning') {
      throw new ProjectConflictError('El proyecto se está clonando: esperá a que termine');
    }
    if (manager.inMaintenance)
      throw new ProjectConflictError('Hay una actualización de Kyro en curso');
    if (this.running.has(project.id)) {
      throw new ProjectConflictError('Ya se está borrando este proyecto');
    }

    const running = chats.list(project.id).filter((chat) => chat.status === 'running').length;
    if (running > 0) {
      throw new DeleteBlockedError(
        `Hay ${String(running)} sesión(es) corriendo en este proyecto: cancelalas antes de borrarlo`,
        [],
        running,
      );
    }
    this.running.add(project.id);
    try {
      const repoExists = existsSync(join(project.repoPath, '.git'));
      // A folder that is not a repo cannot be checked for unsaved work, so it is never deleted blind.
      if (!repoExists && existsSync(project.repoPath)) {
        throw new DeleteBlockedError(
          'La carpeta del clon existe pero no es un repo git: no se puede verificar que no haya trabajo sin guardar. Revisala o borrala a mano',
          [
            {
              path: project.repoPath,
              kind: 'uncommitted',
              detail: 'carpeta sin .git, sin verificar',
            },
          ],
          0,
        );
      }
      const blockers = repoExists ? await this.findWork(project.repoPath) : [];
      if (blockers.length > 0) {
        throw new DeleteBlockedError(
          'Hay trabajo sin guardar en GitHub: commiteá y pusheá antes de borrar el proyecto',
          blockers,
          0,
        );
      }
      const cloneRemoved = await this.removeFiles(project.repoPath, project.name, repoExists);
      projects.deleteWithDependents(project.id);
      return { cloneRemoved };
    } catch (error) {
      if (error instanceof ProjectError || error instanceof DeleteBlockedError) throw error;
      throw new DeletePartialError(
        `El borrado quedó a medias y el proyecto sigue registrado; se puede reintentar: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.running.delete(project.id);
    }
  }

  /** Worktrees first, then the clone; only ever inside the configured directories. */
  private async removeFiles(repoPath: string, name: string, repoExists: boolean): Promise<boolean> {
    const { config } = this.deps;
    const cloneRemoved = await this.canRemoveClone(repoPath);
    if (repoExists && !cloneRemoved) await this.detachWorktrees(repoPath, name);
    const worktrees = resolve(config.worktreesDir, name);
    if (isDirectChild(resolve(config.worktreesDir), worktrees)) {
      await rm(worktrees, { recursive: true, force: true });
    }
    if (cloneRemoved) await rm(repoPath, { recursive: true, force: true });
    else if (repoExists) await git(repoPath, ['worktree', 'prune']);
    return cloneRemoved;
  }

  /** The clone is deleted only if it is a real folder (no symlink) directly under projectsDir. */
  private async canRemoveClone(repoPath: string): Promise<boolean> {
    if (!existsSync(repoPath)) return false;
    const stats = await lstat(repoPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
    const root = await realpath(this.deps.config.projectsDir).catch(() => null);
    if (root === null) return false;
    return isDirectChild(root, await realpath(repoPath));
  }

  /** The clone stays on disk, so the worktrees we are about to delete must not stay registered. */
  private async detachWorktrees(repoPath: string, name: string): Promise<void> {
    const prefix = resolve(this.deps.config.worktreesDir, name) + sep;
    const listing = await git(repoPath, ['worktree', 'list', '--porcelain']);
    for (const line of listing.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const path = resolve(line.slice('worktree '.length));
      if (path.startsWith(prefix)) await git(repoPath, ['worktree', 'remove', '--force', path]);
    }
  }
}
