import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Same shape of plain branch name that `pushArgs` accepts: no spaces, no '..', no leading '-'. */
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function isValidBaseBranch(branch: string): boolean {
  return BRANCH.test(branch) && !branch.includes('..');
}

/** True when the root repo ignores `folder` (`git check-ignore -q`: exit 0 = ignored). */
async function ignoredByRoot(root: string, folder: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', root, 'check-ignore', '-q', '--', folder]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Child repos of a base clone: first-level, non-hidden folders that hold a `.git` and that the
 * root ignores (that is what tells a child repo from a submodule or a versioned folder).
 * Returns relative folder names, sorted.
 */
export async function detectRepos(repoPath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(repoPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!existsSync(join(repoPath, entry.name, '.git'))) continue;
    if (await ignoredByRoot(repoPath, entry.name)) found.push(entry.name);
  }
  return found.sort();
}
