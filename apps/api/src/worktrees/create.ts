import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Project } from '@agents-panel/shared';

const execFileAsync = promisify(execFile);

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SLUG_LENGTH = 50;

export class WorktreeError extends Error {
  override readonly name = 'WorktreeError';
}

export interface WorktreeResult {
  path: string;
  branch: string;
}

export interface WorktreeOptions {
  /** Branch to create; defaults to feature/<slug>. */
  branch?: string;
  /** Skips the project's setup command (a worktree that only commits files needs no dependencies). */
  skipSetup?: boolean;
}

export type WorktreeLog = (type: string, payload: Record<string, unknown>) => void;

export function validateSlug(slug: string): void {
  if (slug.length === 0 || slug.length > MAX_SLUG_LENGTH || !SLUG_PATTERN.test(slug)) {
    throw new WorktreeError(
      `Invalid slug: use kebab-case (a-z, 0-9, hyphens), at most ${String(MAX_SLUG_LENGTH)} characters`,
    );
  }
}

/**
 * Splits a command line into argv without a shell: whitespace separates words and
 * single/double quotes group them. No expansion, pipes or redirects exist.
 */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let inWord = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
    } else if (/\s/.test(char)) {
      if (inWord) args.push(current);
      current = '';
      inWord = false;
    } else {
      current += char;
      inWord = true;
    }
  }
  if (quote) throw new WorktreeError('setup_command has an unclosed quote');
  if (inWord) args.push(current);
  return args;
}

async function run(
  file: string,
  args: string[],
  cwd: string,
  log: WorktreeLog,
  label: string,
): Promise<void> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    log('worktree_output', { step: label, stdout, stderr });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    log('worktree_output', { step: label, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message });
    throw new WorktreeError(`${label} failed: ${(e.stderr ?? e.message).trim().slice(0, 500)}`);
  }
}

/**
 * Runs the project's setup_command (no shell) inside a worktree; no command, nothing to do. Used
 * when the work is created and again when the user reinstalls its dependencies.
 */
export async function runSetup(
  project: Pick<Project, 'setupCommand'>,
  path: string,
  log: WorktreeLog = () => undefined,
): Promise<void> {
  if (!project.setupCommand) return;
  const [file, ...args] = splitCommand(project.setupCommand);
  if (file) await run(file, args, path, log, 'setup');
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync('git', [
      '-C',
      repoPath,
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates <worktreesDir>/<project>/<slug> on a new branch feature/<slug> from the project's
 * base branch, then runs the project's setup_command inside it. Anything created is removed on failure.
 * Every command goes through execFile (no shell); user input is only ever an argv element.
 */
export async function createWorktree(
  project: Project,
  slug: string,
  worktreesDir: string,
  log: WorktreeLog = () => undefined,
  options: WorktreeOptions = {},
): Promise<WorktreeResult> {
  validateSlug(slug);
  const path = join(worktreesDir, project.name, slug);
  const branch = options.branch ?? `feature/${slug}`;

  if (await branchExists(project.repoPath, branch)) {
    throw new WorktreeError(`Branch already exists: ${branch}`);
  }
  if (existsSync(path)) {
    throw new WorktreeError(`Worktree path already exists: ${path}`);
  }

  try {
    await run(
      'git',
      ['-C', project.repoPath, 'worktree', 'add', path, '-b', branch, project.baseBranch],
      project.repoPath,
      log,
      'git worktree add',
    );
    if (!options.skipSetup) await runSetup(project, path, log);
  } catch (error) {
    await rollback(project.repoPath, path, branch);
    throw error;
  }
  return { path, branch };
}

/** Removes a worktree and its branch; best effort, never throws. */
export async function removeWorktree(
  repoPath: string,
  path: string,
  branch: string,
): Promise<void> {
  await rollback(repoPath, path, branch);
}

async function rollback(repoPath: string, path: string, branch: string): Promise<void> {
  try {
    await execFileAsync('git', ['-C', repoPath, 'worktree', 'remove', '--force', path]);
  } catch {
    // Not registered (add failed early); fall through to the filesystem cleanup.
  }
  await rm(path, { recursive: true, force: true });
  try {
    await execFileAsync('git', ['-C', repoPath, 'worktree', 'prune']);
    if (await branchExists(repoPath, branch)) {
      await execFileAsync('git', ['-C', repoPath, 'branch', '-D', branch]);
    }
  } catch {
    // Best effort: the original error is what matters to the caller.
  }
}
