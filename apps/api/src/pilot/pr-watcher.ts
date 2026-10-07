import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Chat, WorktreeStateId } from '@agents-panel/shared';
import type { ChatRepository } from '../chats/repo.js';
import type { ProjectRepository } from '../projects/repo.js';
import type { WorktreeStateRepository } from '../worktrees/state-repo.js';
import { prStateOf, type PrState } from './github-cli.js';
import type { PrLookup } from './pr-lookup.js';

/** State of one PR in GitHub; injectable so tests never call GitHub. */
export type PrStateReader = (cwd: string, url: string) => Promise<PrState>;

/** States in which a work waits for its PRs to be merged in GitHub. */
export const WATCHED_STATES: readonly WorktreeStateId[] = ['pr_lista', 'terminado'];

export interface PrWatcherDeps {
  chats: Pick<ChatRepository, 'findById'>;
  states: Pick<WorktreeStateRepository, 'get' | 'transition' | 'chatIdsIn'>;
  projects: Pick<ProjectRepository, 'findById'>;
  prs: Pick<PrLookup, 'urls'>;
  prState?: PrStateReader;
  log?: (message: string) => void;
}

/** What a check concluded for one work. */
export type PrCheck = 'merged' | 'closed' | 'open' | 'none' | 'skipped' | 'failed';

/**
 * Follows the PRs of a work after the pilot left them open (or the agent opened them): when GitHub
 * reports every PR merged the work moves to `mergeada`; when none is open and one was closed
 * without merging, to `revisar`. The signal is `gh`, never the agent's text; a failing `gh` changes
 * nothing and the next round tries again.
 */
export class PrWatcher {
  private readonly prState: PrStateReader;
  private readonly inFlight = new Set<number>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: PrWatcherDeps) {
    this.prState = deps.prState ?? prStateOf;
  }

  /** Checks every watched work now and then every `intervalMs`; 0 leaves the polling off. */
  start(intervalMs: number): void {
    if (intervalMs <= 0 || this.timer !== undefined) return;
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One round over every watched work; it never throws (the timer has nobody to catch it). */
  async checkAll(): Promise<void> {
    let chatIds: number[];
    try {
      chatIds = this.deps.states.chatIdsIn(WATCHED_STATES);
    } catch (error) {
      this.deps.log?.(
        `PR check round failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    for (const chatId of chatIds) {
      const chat = this.deps.chats.findById(chatId);
      if (chat === undefined) continue;
      // One failing work (a locked database, a broken row) never stops the round.
      try {
        await this.check(chat);
      } catch (error) {
        this.deps.log?.(
          `PR check of chat ${String(chat.id)} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Checks one work; a second call while the first is still asking GitHub is skipped. `urls` are
   * the work's PRs when the caller already looked them up.
   */
  async check(chat: Chat, urls?: readonly string[]): Promise<PrCheck> {
    if (this.inFlight.has(chat.id)) return 'skipped';
    this.inFlight.add(chat.id);
    try {
      return await this.checkNow(chat, urls);
    } finally {
      this.inFlight.delete(chat.id);
    }
  }

  private async checkNow(chat: Chat, known?: readonly string[]): Promise<PrCheck> {
    const { states } = this.deps;
    const watched = (): boolean => {
      const state = states.get(chat.id)?.state;
      return state !== undefined && WATCHED_STATES.includes(state);
    };
    if (chat.kind === 'direct' || chat.kind === 'idea' || chat.status === 'running') {
      return 'skipped';
    }
    if (!watched()) return 'skipped';
    const since = states.get(chat.id)?.since;
    const urls = known ?? (await this.deps.prs.urls(chat));
    if (urls.length === 0) return 'none';
    const cwd = this.cwdOf(chat);
    let found: { url: string; state: PrState }[];
    try {
      // In parallel: a work with child repos must not make the chat slow to open.
      found = await Promise.all(
        urls.map(async (url) => ({ url, state: await this.prState(cwd, url) })),
      );
    } catch (error) {
      this.deps.log?.(
        `PR check of chat ${String(chat.id)} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'failed';
    }
    if (found.some((pr) => pr.state === 'OPEN')) return 'open';
    // The state may have moved while GitHub answered (a new turn, a manual delete).
    const current = states.get(chat.id);
    const fresh = this.deps.chats.findById(chat.id);
    // Left and came back while GitHub answered: the PRs read may not be the work's anymore.
    if (
      current === undefined ||
      current.since !== since ||
      !watched() ||
      fresh?.status === 'running'
    ) {
      return 'skipped';
    }
    const progress = {
      phase: current.phase,
      sprintCurrent: current.sprintCurrent,
      sprintClosed: current.sprintClosed,
      sprintTotal: current.sprintTotal,
      taskDone: current.taskDone,
      taskTotal: current.taskTotal,
      openDebt: current.openDebt,
      blockedReason: current.blockedReason,
      role: current.role,
      model: current.model,
    };
    const closed = found.filter((pr) => pr.state === 'CLOSED').map((pr) => pr.url);
    if (closed.length > 0) {
      states.transition(chat.id, {
        ...progress,
        state: 'revisar',
        actor: 'pilot',
        reason: 'Una PR se cerró sin mergear',
        detail: closed.join(', '),
        data: { prUrls: urls, closed },
      });
      return 'closed';
    }
    states.transition(chat.id, {
      ...progress,
      state: 'mergeada',
      actor: 'pilot',
      reason: urls.length > 1 ? 'Todas las PR están mergeadas' : 'La PR está mergeada',
      detail: urls.join(', '),
      data: { prUrls: urls },
    });
    return 'merged';
  }

  /** Where `gh` runs: any existing folder works, since the PR goes by its full URL. */
  private cwdOf(chat: Chat): string {
    if (existsSync(chat.worktreePath)) return chat.worktreePath;
    const repoPath = this.deps.projects.findById(chat.projectId)?.repoPath;
    return repoPath !== undefined && existsSync(repoPath) ? repoPath : tmpdir();
  }
}
