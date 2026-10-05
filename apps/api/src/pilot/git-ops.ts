import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 60_000;
/** A pull or a push may move real data: more room than a status. */
const GIT_NETWORK_TIMEOUT_MS = 5 * 60_000;

/** Runs a program with argv (no shell); injectable so a test can record every argv. */
export type Exec = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: Exec = (file, args, options) =>
  execFileAsync(file, args, { timeout: options.timeout, maxBuffer: 4 * 1024 * 1024 });

/** The git operations the pilot runs itself (never the agent). Injectable so tests use a fake. */
export interface PilotGit {
  /**
   * Commits only what changed under `.agents/kyro/` (never `git add -A`); `committed` is false
   * when there was nothing to commit. Rejects with the git output when git fails.
   */
  commitKyro(cwd: string, message: string): Promise<{ committed: boolean }>;
  /** Commit HEAD points to. */
  head(cwd: string): Promise<string>;
  /** Commit a local branch points to; '' when the branch does not exist. */
  branchHead(cwd: string, branch: string): Promise<string>;
  /** Pushes the branch to origin (see `pushArgs`); rejects with the trimmed git output. */
  push(cwd: string, branch: string): Promise<void>;
}

/** The git operations of the merge phase (bringing the base in, conflicts, pending work). */
export interface MergeGit {
  /** True when the worktree has changes that are not committed (untracked files included). */
  hasPendingChanges(cwd: string): Promise<boolean>;
  /** Commits everything pending; the pilot only calls it after the secrets scan came out clean. */
  commitPending(cwd: string, message: string): Promise<{ committed: boolean }>;
  /**
   * `git pull --no-rebase origin <base>`: brings the base into the branch as a merge. A conflict
   * is not an error: it is `ok: false` and the caller reads `unmergedPaths`.
   */
  pull(cwd: string, base: string): Promise<{ ok: boolean; output: string }>;
  /** Paths with an unresolved merge (`git diff --diff-filter=U`). */
  unmergedPaths(cwd: string): Promise<string[]>;
  /** True while a merge is open (MERGE_HEAD exists). */
  mergeInProgress(cwd: string): Promise<boolean>;
  /** Name of the checked-out branch ('' when HEAD is detached). */
  currentBranch(cwd: string): Promise<string>;
  /** True when HEAD is already contained in `ref` (the branch reached the base). */
  isAncestor(cwd: string, ref: string): Promise<boolean>;
}

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function checkBranch(branch: string, what: string): void {
  if (!BRANCH.test(branch) || branch.includes('..')) {
    throw new Error(`Nombre de rama no válido para ${what}: ${branch}`);
  }
}

/**
 * argv of the push. The branch is only ever a plain name: never a refspec (`+`, `:`), an option or
 * a force (R12: pushes are never forced, and rebases of pushed branches do not exist).
 */
export function pushArgs(branch: string): string[] {
  checkBranch(branch, 'el push');
  return ['push', '-u', 'origin', branch];
}

/** argv of the pull: a merge (`--no-rebase`) of origin's base into the current branch (R13). */
export function pullArgs(base: string): string[] {
  checkBranch(base, 'el pull');
  return ['pull', '--no-rebase', '--no-edit', 'origin', base];
}

function failure(args: string[], error: unknown): Error {
  const out = error as { stderr?: unknown; stdout?: unknown; message?: string };
  const text = [out.stderr, out.stdout]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join('\n');
  const detail = text === '' ? (out.message ?? '') : text;
  return new Error(`git ${args[0] ?? ''} falló: ${detail.trim().slice(0, 500)}`, { cause: error });
}

/** The real operations, over an `exec` that tests can replace to see every argv. */
export function createGit(exec: Exec = defaultExec): PilotGit & MergeGit {
  const git = async (cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> => {
    try {
      return (await exec('git', ['-C', cwd, ...args], { timeout })).stdout;
    } catch (error) {
      throw failure(args, error);
    }
  };
  return {
    async commitKyro(cwd, message) {
      if (!existsSync(join(cwd, '.agents', 'kyro'))) return { committed: false };
      await git(cwd, ['add', '--', '.agents/kyro']);
      const staged = await git(cwd, ['diff', '--cached', '--name-only', '--', '.agents/kyro']);
      if (staged.trim() === '') return { committed: false };
      // The pathspec keeps anything else the agent staged out of this commit.
      await git(cwd, ['commit', '-m', message, '--', '.agents/kyro']);
      return { committed: true };
    },
    async head(cwd) {
      return (await git(cwd, ['rev-parse', 'HEAD'])).trim();
    },
    async branchHead(cwd, branch) {
      try {
        return (
          await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
        ).trim();
      } catch {
        return '';
      }
    },
    async push(cwd, branch) {
      await git(cwd, pushArgs(branch), GIT_NETWORK_TIMEOUT_MS);
    },
    async hasPendingChanges(cwd) {
      return (await git(cwd, ['status', '--porcelain'])).trim() !== '';
    },
    async commitPending(cwd, message) {
      await git(cwd, ['add', '-A']);
      if ((await git(cwd, ['diff', '--cached', '--name-only'])).trim() === '') {
        return { committed: false };
      }
      await git(cwd, ['commit', '-m', message]);
      return { committed: true };
    },
    async pull(cwd, base) {
      try {
        const out = await git(cwd, pullArgs(base), GIT_NETWORK_TIMEOUT_MS);
        return { ok: true, output: out.trim().slice(0, 2000) };
      } catch (error) {
        return { ok: false, output: error instanceof Error ? error.message : 'git pull falló' };
      }
    },
    async unmergedPaths(cwd) {
      const out = await git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z']);
      return out.split('\0').filter((file) => file !== '');
    },
    async currentBranch(cwd) {
      return (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim().replace(/^HEAD$/, '');
    },
    async isAncestor(cwd, ref) {
      try {
        await git(cwd, ['merge-base', '--is-ancestor', 'HEAD', ref]);
        return true;
      } catch {
        return false;
      }
    },
    async mergeInProgress(cwd) {
      try {
        await git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export const realGit: PilotGit & MergeGit = createGit();
