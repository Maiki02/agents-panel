import { existsSync } from 'node:fs';
import type { Chat, WorktreeStateId } from '@agents-panel/shared';
import type { ProjectRepository } from '../projects/repo.js';
import type { WorktreeStateRepository } from '../worktrees/state-repo.js';
import { allPrsOf } from './github-cli.js';
import type { AutopilotRunRepository } from './runs-repo.js';

/** Every PR of a branch in GitHub (any state); injectable so tests never call GitHub. */
export type BranchPrs = (cwd: string, head: string) => Promise<string[]>;

/** States in which a work may have left a PR behind. */
const LOOKUP_STATES: readonly WorktreeStateId[] = ['terminado', 'pr_lista'];

export interface PrLookupDeps {
  runs: Pick<AutopilotRunRepository, 'get' | 'setPrUrls'>;
  states: Pick<WorktreeStateRepository, 'get'>;
  projects: Pick<ProjectRepository, 'findById'>;
  prsOf?: BranchPrs;
}

/**
 * The PRs of a work: the ones the pilot kept or, when it kept none and the work is done, the ones
 * GitHub has for its branch (the agent may have opened it by itself). The signal is `gh`, never
 * the agent's text. A failing lookup is an empty list: the card simply does not show.
 */
export class PrLookup {
  private readonly prsOf: BranchPrs;

  constructor(private readonly deps: PrLookupDeps) {
    this.prsOf = deps.prsOf ?? allPrsOf;
  }

  async urls(chat: Pick<Chat, 'id' | 'projectId' | 'worktreePath' | 'branch'>): Promise<string[]> {
    const { runs, states, projects } = this.deps;
    const run = runs.get(chat.id);
    if (run !== undefined && run.prUrls.length > 0) return run.prUrls;
    const state = states.get(chat.id)?.state;
    if (state === undefined || !LOOKUP_STATES.includes(state)) return [];
    // The worktree may be gone already; the project's clone knows the same remote.
    const cwd = existsSync(chat.worktreePath)
      ? chat.worktreePath
      : projects.findById(chat.projectId)?.repoPath;
    if (cwd === undefined || !existsSync(cwd)) return [];
    let urls: string[];
    try {
      urls = await this.prsOf(cwd, chat.branch);
    } catch {
      return [];
    }
    if (urls.length > 0 && run !== undefined) runs.setPrUrls(chat.id, urls);
    return urls;
  }
}
