import type { ProjectRepo } from '@agents-panel/shared';
import type { Db } from '../db/index.js';
import { ProjectError } from './repo.js';
import { isValidBaseBranch } from './repos.js';

interface RepoRow {
  id: number;
  project_id: number;
  path: string;
  base_branch: string;
}

function toRepo(row: RepoRow): ProjectRepo {
  return {
    id: row.id,
    projectId: row.project_id,
    path: row.path,
    baseBranch: row.base_branch,
  };
}

/** The repos of each project (root '.' plus detected children) with their editable base. */
export class ProjectRepoRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Root first, then children by path. */
  listByProject(projectId: number): ProjectRepo[] {
    return (
      this.db
        .prepare("SELECT * FROM project_repos WHERE project_id = ? ORDER BY (path <> '.'), path")
        .all(projectId) as unknown as RepoRow[]
    ).map(toRepo);
  }

  findById(id: number): ProjectRepo | undefined {
    const row = this.db.prepare('SELECT * FROM project_repos WHERE id = ?').get(id) as
      RepoRow | undefined;
    return row ? toRepo(row) : undefined;
  }

  /**
   * Stores the outcome of a detection. The root ('.') always exists and follows `rootBase` only
   * when it is created; existing rows keep their (possibly edited) base; new children take
   * `rootBase`; rows of children that no longer exist are removed, never the root.
   */
  syncDetected(projectId: number, rootBase: string, children: readonly string[]): ProjectRepo[] {
    const now = this.now();
    const insert = this.db.prepare(
      `INSERT INTO project_repos (project_id, path, base_branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (project_id, path) DO NOTHING`,
    );
    this.db.exec('BEGIN');
    try {
      insert.run(projectId, '.', rootBase, now, now);
      for (const child of children) insert.run(projectId, child, rootBase, now, now);
      const keep = new Set(['.', ...children]);
      for (const row of this.listByProject(projectId)) {
        if (!keep.has(row.path)) {
          this.db.prepare('DELETE FROM project_repos WHERE id = ?').run(row.id);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.listByProject(projectId);
  }

  /** Changes the base of one repo; the name must be a plain branch name. */
  updateBase(id: number, baseBranch: string): ProjectRepo {
    const branch = baseBranch.trim();
    if (!isValidBaseBranch(branch)) throw new ProjectError(`Rama base no válida: ${branch}`);
    const result = this.db
      .prepare('UPDATE project_repos SET base_branch = ?, updated_at = ? WHERE id = ?')
      .run(branch, this.now(), id);
    const repo = result.changes > 0 ? this.findById(id) : undefined;
    if (!repo) throw new ProjectError(`Repo no encontrado: ${String(id)}`);
    return repo;
  }
}
