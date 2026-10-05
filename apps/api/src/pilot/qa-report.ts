import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

/** Verdicts of kyro-qa that let a closing session stand. */
export const APPROVED_VERDICTS: readonly string[] = ['APPROVED', 'APPROVED WITH NOTES'];

const VERDICT_LINE = /^Verdict: (APPROVED WITH NOTES|APPROVED|CHANGES REQUIRED|REJECTED)$/;
const MAX_READ_BYTES = 4096;

/** Fixed path, relative to the worktree, of the QA report a closing session writes (R7). */
export function qaReportPath(scope: string, sprintN: number): string {
  return path.posix.join('.agents', 'kyro', 'qa', scope, `sprint-${String(sprintN)}.md`);
}

export type QaVerdict = { ok: true; verdict: string } | { ok: false; detail: string };

/**
 * Reads the first line of the QA report of a sprint. Anything but a regular file inside the
 * worktree (a symlink, a path that leaves it, a missing file) counts as "no report".
 */
export async function readQaVerdict(
  worktree: string,
  scope: string,
  sprintN: number,
): Promise<QaVerdict> {
  const none: QaVerdict = { ok: false, detail: 'sin informe' };
  const file = path.join(worktree, qaReportPath(scope, sprintN));
  try {
    const root = await realpath(worktree);
    const real = await realpath(path.dirname(file));
    if (real !== root && !real.startsWith(root + path.sep)) return none;
    const info = await lstat(file);
    if (!info.isFile()) return none;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(MAX_READ_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, MAX_READ_BYTES, 0);
      const first = buffer.toString('utf8', 0, bytesRead).split(/\r?\n/, 1)[0] ?? '';
      const match = VERDICT_LINE.exec(first);
      if (!match?.[1]) return { ok: false, detail: 'informe sin la línea "Verdict: <VEREDICTO>"' };
      return { ok: true, verdict: match[1] };
    } finally {
      await handle.close();
    }
  } catch {
    return none;
  }
}
