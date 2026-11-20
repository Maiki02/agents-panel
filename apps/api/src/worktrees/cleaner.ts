import type { Chat, DeletePreview, WorktreeStateId } from '@agents-panel/shared';
import type { ChatRepository } from '../chats/repo.js';
import { WorktreeOpsError, type WorktreeOps } from './ops.js';
import type { WorktreeStateRepository } from './state-repo.js';

const HOUR_MS = 60 * 60 * 1000;

export interface WorktreeCleanerDeps {
  chats: Pick<ChatRepository, 'findById'>;
  states: Pick<WorktreeStateRepository, 'get' | 'transition' | 'chatIdsIn'>;
  ops: Pick<WorktreeOps, 'deletePreview' | 'deleteWork' | 'assertIdle'>;
  /** Hours a work stays in `mergeada` before its worktree is deleted; 0 turns the cleaner off. */
  afterMergeHours: number;
  now?: () => number;
  log?: (message: string) => void;
}

/** What a round did with one work. */
export type CleanResult = 'deleted' | 'reviewed' | 'busy' | 'too_soon' | 'skipped' | 'failed';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Why the preview says the work cannot be deleted without losing something; null when it can. */
export function deleteBlockers(preview: DeletePreview): string | null {
  const lines: string[] = [];
  for (const repo of preview.repos) {
    if (repo.error !== null) lines.push(`${repo.path}: ${repo.error}`);
    if (repo.uncommittedFiles.length > 0) {
      lines.push(`${repo.path}: ${String(repo.uncommittedFiles.length)} archivo(s) sin commitear`);
    }
    if (repo.unpushedCommits > 0) {
      lines.push(`${repo.path}: ${String(repo.unpushedCommits)} commit(s) sin pushear`);
    }
  }
  return lines.length === 0 ? null : lines.join('; ');
}

/**
 * Deletes the worktree of every work that has been `mergeada` for more than the configured hours,
 * one at a time, through `WorktreeOps` as the pilot. A work with something not committed or not
 * pushed goes to `revisar` with the detail; a busy one (409) is left as it is for the next round.
 */
export class WorktreeCleaner {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly deps: WorktreeCleanerDeps) {}

  /** Cleans now and then every `intervalMs`; off when the hours or the interval are 0. */
  start(intervalMs: number): void {
    if (this.deps.afterMergeHours <= 0 || intervalMs <= 0 || this.timer !== undefined) return;
    void this.cleanAll();
    this.timer = setInterval(() => void this.cleanAll(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One round; it never throws (the timer has nobody to catch it). Rounds never overlap. */
  async cleanAll(): Promise<Map<number, CleanResult>> {
    const results = new Map<number, CleanResult>();
    if (this.deps.afterMergeHours <= 0 || this.running) return results;
    this.running = true;
    try {
      let chatIds: number[];
      try {
        chatIds = this.deps.states.chatIdsIn(['mergeada']);
      } catch (error) {
        this.deps.log?.(`Cleanup round failed: ${message(error)}`);
        return results;
      }
      for (const chatId of chatIds) {
        try {
          results.set(chatId, await this.clean(chatId));
        } catch (error) {
          results.set(chatId, 'failed');
          this.deps.log?.(`Cleanup of chat ${String(chatId)} failed: ${message(error)}`);
        }
      }
    } finally {
      this.running = false;
    }
    return results;
  }

  /** Cleans one work if it is due. */
  async clean(chatId: number): Promise<CleanResult> {
    const { chats, states, ops } = this.deps;
    const chat = chats.findById(chatId);
    if (chat?.worktreePath === undefined || chat.worktreePath === '') return 'skipped';
    if (states.get(chatId)?.state !== 'mergeada') return 'skipped';
    if (!this.isDue(chat)) return 'too_soon';
    try {
      // The pilot actor skips the idle guards inside the service: they are checked here.
      ops.assertIdle(chatId);
      const preview = await ops.deletePreview(chatId);
      const blockers = deleteBlockers(preview);
      if (blockers !== null) {
        this.toReview(chat, 'No se borró el trabajo: hay algo sin guardar', blockers, { preview });
        return 'reviewed';
      }
      await ops.deleteWork(chatId, true, 'pilot');
      return 'deleted';
    } catch (error) {
      if (error instanceof WorktreeOpsError && error.status === 409) return 'busy';
      // deleteWork leaves the work in `revisar` by itself when it fails halfway.
      if (states.get(chatId)?.state === 'mergeada') {
        this.toReview(chat, 'La limpieza automática falló', message(error), {});
      }
      return 'failed';
    }
  }

  private isDue(chat: Chat): boolean {
    if (chat.mergedAt === null) return false;
    const mergedAt = Date.parse(chat.mergedAt);
    if (Number.isNaN(mergedAt)) return false;
    const now = (this.deps.now ?? Date.now)();
    return now - mergedAt > this.deps.afterMergeHours * HOUR_MS;
  }

  private toReview(
    chat: Chat,
    reason: string,
    detail: string,
    data: Record<string, unknown>,
  ): void {
    const current = this.deps.states.get(chat.id);
    this.deps.states.transition(chat.id, {
      state: 'revisar' satisfies WorktreeStateId,
      actor: 'pilot',
      reason,
      detail,
      phase: current?.phase ?? null,
      sprintCurrent: current?.sprintCurrent ?? null,
      sprintClosed: current?.sprintClosed ?? null,
      sprintTotal: current?.sprintTotal ?? null,
      taskDone: current?.taskDone ?? null,
      taskTotal: current?.taskTotal ?? null,
      openDebt: current?.openDebt ?? null,
      role: current?.role ?? null,
      model: current?.model ?? null,
      data: { op: 'cleanup', ...data },
    });
  }
}
