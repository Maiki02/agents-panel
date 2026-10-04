import { existsSync } from 'node:fs';
import type { Chat, EnvApplyResult } from '@agents-panel/shared';
import { EnvFileError } from './validate.js';
import { writeEnvFiles } from './write.js';

/**
 * Writes one freshly saved .env into every active worktree (a chat whose worktree still exists).
 * Each worktree is independent: a failure is reported as skipped and the rest go on.
 * A chat with a running agent is skipped too: the agent could swap a folder for a symlink while
 * the file is written (debt-6), so it gets the file on its next chat instead.
 */
export const RUNNING_AGENT_REASON =
  'agente en curso: se aplica cuando termine o en el próximo chat';

export async function applyEnvFileToWorktrees(
  chats: Chat[],
  file: { path: string; content: string },
): Promise<EnvApplyResult[]> {
  const results: EnvApplyResult[] = [];
  for (const chat of chats) {
    if (!existsSync(chat.worktreePath)) continue;
    if (chat.status === 'running') {
      results.push({
        chatId: chat.id,
        worktreePath: chat.worktreePath,
        status: 'skipped',
        reason: RUNNING_AGENT_REASON,
      });
      continue;
    }
    try {
      await writeEnvFiles(chat.worktreePath, [file]);
      results.push({
        chatId: chat.id,
        worktreePath: chat.worktreePath,
        status: 'written',
        reason: null,
      });
    } catch (error) {
      const reason =
        error instanceof EnvFileError
          ? error.message
          : 'no se pudo escribir el .env en el worktree';
      results.push({ chatId: chat.id, worktreePath: chat.worktreePath, status: 'skipped', reason });
    }
  }
  return results;
}
