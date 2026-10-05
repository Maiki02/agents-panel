import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DeleteBlocker } from '@agents-panel/shared';
import { git } from './git.js';

/** Work that deleting the project would lose; `path` is the clone, worktree or nested repo. */
export type Blocker = DeleteBlocker;

const LIST_MAX = 5;
const SKIPPED_DIRS = new Set(['node_modules', '.git']);

function summarize(lines: string[]): string {
  const shown = lines.slice(0, LIST_MAX).join(', ');
  return lines.length > LIST_MAX ? `${shown} y ${String(lines.length - LIST_MAX)} más` : shown;
}

/** Folders of the clone and of every worktree git knows, skipping ones whose folder is gone. */
async function worktreeFolders(repoPath: string): Promise<string[]> {
  const out = await git(repoPath, ['worktree', 'list', '--porcelain']);
  const folders = out
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length)));
  return folders.filter((folder) => existsSync(folder));
}

/** Repos one level below `dir` (e.g. the child repos of a monorepo wrapper, ignored by the parent). */
async function nestedRepos(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && !SKIPPED_DIRS.has(e.name))
    .map((e) => join(dir, e.name))
    .filter((child) => existsSync(join(child, '.git')));
}

async function uncommitted(folder: string): Promise<Blocker[]> {
  // Honors .gitignore, so the .env files the panel writes (ignored by git) never count.
  const status = await git(folder, ['status', '--porcelain']);
  if (status === '') return [];
  // git() trims the output, which can eat the leading space of the first status code.
  const files = status.split('\n').map((line) => line.replace(/^\S{1,2}\s+/, ''));
  return [{ path: folder, kind: 'uncommitted', detail: summarize(files) }];
}

/** Local branches (and a detached HEAD) with commits that no remote-tracking branch contains. */
async function unpushed(folder: string, includeBranches: boolean): Promise<Blocker[]> {
  const found: Blocker[] = [];
  if (includeBranches) {
    const branches = (
      await git(folder, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    )
      .split('\n')
      .filter((name) => name !== '');
    for (const branch of branches) {
      const count = Number(
        await git(folder, ['rev-list', '--count', `refs/heads/${branch}`, '--not', '--remotes']),
      );
      if (count > 0) {
        found.push({
          path: folder,
          kind: 'unpushed',
          detail: `rama ${branch}: ${String(count)} commit(s) sin pushear`,
        });
      }
    }
  }
  const detached = (await git(folder, ['rev-parse', '--abbrev-ref', 'HEAD'])) === 'HEAD';
  if (detached) {
    const count = Number(await git(folder, ['rev-list', '--count', 'HEAD', '--not', '--remotes']));
    if (count > 0) {
      found.push({
        path: folder,
        kind: 'unpushed',
        detail: `HEAD suelto: ${String(count)} commit(s) sin pushear`,
      });
    }
  }
  return found;
}

/**
 * Read-only: lists what deleting the project would lose. Looks at the base clone, every worktree
 * of it and the repos nested one level down. Nothing is fetched, so a branch counts as pushed
 * only if a remote-tracking ref of this clone contains it (a push from here updates that ref).
 */
export async function findUnsavedWork(repoPath: string): Promise<Blocker[]> {
  const folders = await worktreeFolders(repoPath);
  const blockers: Blocker[] = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    blockers.push(...(await uncommitted(folder)));
    // Branches are shared by the clone and all its worktrees: list them once, from the clone.
    blockers.push(...(await unpushed(folder, folder === resolve(repoPath))));
    for (const nested of await nestedRepos(folder)) {
      if (seen.has(nested)) continue;
      seen.add(nested);
      blockers.push(...(await uncommitted(nested)));
      blockers.push(...(await unpushed(nested, true)));
    }
  }
  return blockers;
}
