import { existsSync } from 'node:fs';
import type { Chat, EnvApplyResult } from '@agents-panel/shared';
import { EnvFileError } from './validate.js';
import { writeEnvFiles } from './write.js';

/**
 * Writes one freshly saved .env into every active worktree (a chat whose worktree still exists).
 * Each worktree is independent: a failure is reported as skipped and the rest go on.
 */
export async function applyEnvFileToWorktrees(
  chats: Chat[],
  file: { path: string; content: string },
): Promise<EnvApplyResult[]> {
  const results: EnvApplyResult[] = [];
  for (const chat of chats) {
    if (!existsSync(chat.worktreePath)) continue;
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
