import { execFile } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Chat } from '@agents-panel/shared';

const execFileAsync = promisify(execFile);

/** Biggest idea document the panel reads back to the web. */
export const MAX_IDEA_BYTES = 256 * 1024;

/** Folders of `.agents/kyro/` that hold Kyro's own state, never an idea document. */
const NOT_IDEA_DIRS = new Set(['scopes', 'work', 'trace', 'qa']);
const IDEA_PATH = /^\.agents\/kyro\/([^/\0]+)\/(?:[^\0]+\/)?[^/\0]+\.md$/;

/** What the panel needs to find the document kyro-idea wrote. */
export interface IdeaScanner {
  /** Paths (relative to the worktree) of the idea documents new or changed against the base. */
  scan(chat: Chat): Promise<string[]>;
}

/** True for `.agents/kyro/<docType>/…/*.md` where docType is not one of Kyro's state folders. */
export function isIdeaPath(relPath: string): boolean {
  const match = IDEA_PATH.exec(relPath);
  return match?.[1] !== undefined && !NOT_IDEA_DIRS.has(match[1]) && !relPath.includes('..');
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, '--no-optional-locks', ...args], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

/** Paths of `git status --porcelain=v1 -z`; for a rename only the new path counts. */
function statusPaths(output: string): string[] {
  const paths: string[] = [];
  const entries = output.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? '';
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    if (code.includes('D')) continue;
    paths.push(entry.slice(3));
    if (code.includes('R') || code.includes('C')) i++;
  }
  return paths;
}

/**
 * Lists the idea documents of a worktree from git (R7): untracked or modified files under
 * `.agents/kyro/`, plus what the branch already committed against the base. The agent's text is
 * never read.
 */
export async function scanIdeaDocuments(worktree: string, baseBranch?: string): Promise<string[]> {
  const found = new Set<string>();
  const status = await git(worktree, [
    'status',
    '--porcelain=v1',
    '-z',
    '-uall',
    '--',
    '.agents/kyro',
  ]);
  for (const file of statusPaths(status)) found.add(file);
  if (baseBranch !== undefined) {
    try {
      const diff = await git(worktree, [
        'diff',
        '--name-only',
        '-z',
        '--diff-filter=AM',
        `${baseBranch}...HEAD`,
        '--',
        '.agents/kyro',
      ]);
      for (const file of diff.split('\0')) if (file !== '') found.add(file);
    } catch {
      // No base branch to compare with: the uncommitted files are the signal.
    }
  }
  return [...found].filter(isIdeaPath).sort();
}

export type IdeaRead = { ok: true; content: string; truncated: boolean } | { ok: false };

/**
 * Reads an idea document. Anything but a regular `.md` file of `.agents/kyro/<docType>/` that
 * stays inside the worktree (a symlink, a path that leaves it) is refused.
 */
export async function readIdeaDocument(worktree: string, relPath: string): Promise<IdeaRead> {
  if (!isIdeaPath(relPath)) return { ok: false };
  try {
    const root = await realpath(worktree);
    const file = path.join(root, relPath);
    const real = await realpath(path.dirname(file));
    if (real !== root && !real.startsWith(root + path.sep)) return { ok: false };
    const info = await lstat(file);
    if (!info.isFile()) return { ok: false };
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(MAX_IDEA_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, MAX_IDEA_BYTES, 0);
      return {
        ok: true,
        content: buffer.toString('utf8', 0, bytesRead),
        truncated: info.size > MAX_IDEA_BYTES,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return { ok: false };
  }
}
