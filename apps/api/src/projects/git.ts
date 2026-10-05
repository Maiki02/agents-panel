import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PullResult } from '@agents-panel/shared';

const execFileAsync = promisify(execFile);

const NETWORK_TIMEOUT_MS = 120_000;
const OUTPUT_MAX = 2000;

/** The repo cannot be updated right now (local changes, other branch, divergence): the user decides. */
export class PullRejectedError extends Error {
  override readonly name = 'PullRejectedError';
}

/** git itself failed (network, auth, missing remote branch). */
export class GitCommandError extends Error {
  override readonly name = 'GitCommandError';
}

export async function git(cwd: string, args: string[], timeout?: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      maxBuffer: 10 * 1024 * 1024,
      ...(timeout === undefined ? {} : { timeout }),
    });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const text =
      typeof stderr === 'string' && stderr.trim() !== ''
        ? stderr
        : error instanceof Error
          ? error.message
          : String(error);
    throw new GitCommandError(`git ${args[0] ?? ''}: ${text.trim().slice(0, 500)}`);
  }
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', cwd, 'merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Brings `origin/<baseBranch>` into the clone by fast-forward only (fetch, then pull --ff-only).
 * Refuses, touching nothing, when the clone is on another branch, has local changes in tracked
 * files, or has diverged from origin. Everything goes through execFile: no shell.
 */
export async function pullFastForward(repoPath: string, baseBranch: string): Promise<PullResult> {
  if (baseBranch === '' || baseBranch.startsWith('-')) {
    throw new PullRejectedError(`Rama base inválida: ${baseBranch.slice(0, 80)}`);
  }
  const current = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current !== baseBranch) {
    throw new PullRejectedError(
      `El clon está en la rama ${current}, no en la base ${baseBranch}: no se actualiza`,
    );
  }
  // Untracked files never block a fast-forward unless they collide, in which case git refuses it.
  // Changes confined to .agents/kyro/ (a Kyro update rewrites project.json) do not count either:
  // git itself refuses the pull if origin touches the same file.
  const dirty = await git(repoPath, [
    'status',
    '--porcelain',
    '--untracked-files=no',
    '--',
    '.',
    ':(exclude).agents/kyro',
  ]);
  if (dirty !== '') {
    throw new PullRejectedError('El clon tiene cambios locales en archivos versionados');
  }

  const before = await git(repoPath, ['rev-parse', 'HEAD']);
  await git(repoPath, ['fetch', 'origin'], NETWORK_TIMEOUT_MS);
  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  let remote: string;
  try {
    remote = await git(repoPath, ['rev-parse', '--verify', '--quiet', remoteRef]);
  } catch {
    throw new GitCommandError(`origin no tiene la rama ${baseBranch}`);
  }

  if (remote === before || (await isAncestor(repoPath, remote, 'HEAD'))) {
    const ahead =
      remote === before
        ? 0
        : Number(await git(repoPath, ['rev-list', '--count', `${remote}..HEAD`]));
    return { status: 'up_to_date', before, after: before, commits: 0, ahead, output: '' };
  }
  if (!(await isAncestor(repoPath, 'HEAD', remote))) {
    throw new PullRejectedError(
      `El clon y origin/${baseBranch} divergieron: hay commits en ambos lados`,
    );
  }

  const output = await git(
    repoPath,
    ['pull', '--ff-only', 'origin', baseBranch],
    NETWORK_TIMEOUT_MS,
  );
  const after = await git(repoPath, ['rev-parse', 'HEAD']);
  const commits = Number(await git(repoPath, ['rev-list', '--count', `${before}..${after}`]));
  return {
    status: 'updated',
    before,
    after,
    commits,
    ahead: 0,
    output: output.slice(0, OUTPUT_MAX),
  };
}

const KYRO_PROJECT_FILE = '.agents/kyro/project.json';

/**
 * True when Kyro's tracked project.json is modified in the clone, which is what `kyro update`
 * leaves behind. Never throws: an unreadable repo simply has nothing pending.
 */
export async function kyroPendingCommit(repoPath: string): Promise<boolean> {
  try {
    const out = await git(repoPath, [
      'status',
      '--porcelain',
      '--untracked-files=no',
      '--',
      KYRO_PROJECT_FILE,
    ]);
    return out !== '';
  } catch {
    return false;
  }
}
