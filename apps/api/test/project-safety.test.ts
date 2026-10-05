import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findUnsavedWork } from '../src/projects/safety.js';
import { makeGitRepo } from './helpers.js';

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...IDENTITY, ...args], { encoding: 'utf8' }).trim();

/** A clone of a bare origin, like a registered project, plus a helper to add worktrees. */
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'panel-safe-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', makeGitRepo(), origin]);
  const clone = join(root, 'clone');
  execFileSync('git', ['clone', '-q', origin, clone]);
  const addWorktree = (name: string) => {
    const path = join(root, 'wt', name);
    git(clone, 'worktree', 'add', '-q', path, '-b', `feature/${name}`, 'main');
    return path;
  };
  const commit = (folder: string, file: string) => {
    writeFileSync(join(folder, file), 'x\n');
    git(folder, 'add', file);
    git(folder, 'commit', '-q', '-m', `add ${file}`);
  };
  return { root, origin, clone, addWorktree, commit };
}

describe('findUnsavedWork', () => {
  it('finds nothing in a clean project with clean worktrees', async () => {
    const { clone, addWorktree } = makeProject();
    addWorktree('a');
    addWorktree('b');
    expect(await findUnsavedWork(clone)).toEqual([]);
  });

  it('reports uncommitted changes and untracked files with their worktree', async () => {
    const { clone, addWorktree } = makeProject();
    const wt = addWorktree('a');
    writeFileSync(join(wt, 'README.md'), 'edited\n');
    writeFileSync(join(wt, 'new.txt'), 'n\n');
    const blockers = await findUnsavedWork(clone);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ path: wt, kind: 'uncommitted' });
    expect(blockers[0]?.detail).toContain('README.md');
    expect(blockers[0]?.detail).toContain('new.txt');
  });

  it('reports a branch with commits that were never pushed', async () => {
    const { clone, addWorktree, commit } = makeProject();
    const wt = addWorktree('a');
    commit(wt, 'work.txt');
    const blockers = await findUnsavedWork(clone);
    expect(blockers).toEqual([
      { path: clone, kind: 'unpushed', detail: 'rama feature/a: 1 commit(s) sin pushear' },
    ]);
  });

  it('stops reporting the branch once it is pushed', async () => {
    const { clone, addWorktree, commit } = makeProject();
    const wt = addWorktree('a');
    commit(wt, 'work.txt');
    git(wt, 'push', '-q', 'origin', 'feature/a');
    expect(await findUnsavedWork(clone)).toEqual([]);
    commit(wt, 'more.txt');
    expect(await findUnsavedWork(clone)).toHaveLength(1);
  });

  it('reports unpushed commits on the base branch of the clone itself', async () => {
    const { clone, commit } = makeProject();
    commit(clone, 'local.txt');
    const blockers = await findUnsavedWork(clone);
    expect(blockers).toEqual([
      { path: clone, kind: 'unpushed', detail: 'rama main: 1 commit(s) sin pushear' },
    ]);
  });

  it('reports commits on a detached HEAD', async () => {
    const { clone, addWorktree, commit } = makeProject();
    const wt = addWorktree('a');
    git(wt, 'checkout', '-q', '--detach');
    commit(wt, 'loose.txt');
    const blockers = await findUnsavedWork(clone);
    expect(blockers).toEqual([
      { path: wt, kind: 'unpushed', detail: 'HEAD suelto: 1 commit(s) sin pushear' },
    ]);
  });

  it('ignores files git ignores, such as the .env the panel writes', async () => {
    const { clone, addWorktree, commit } = makeProject();
    writeFileSync(join(clone, '.gitignore'), '.env*\n');
    git(clone, 'add', '.gitignore');
    git(clone, 'commit', '-q', '-m', 'ignore env');
    git(clone, 'push', '-q', 'origin', 'main');
    const wt = addWorktree('a');
    writeFileSync(join(wt, '.env'), 'SECRET=1\n');
    expect(await findUnsavedWork(clone)).toEqual([]);
    commit(wt, 'a.txt');
    expect(await findUnsavedWork(clone)).toHaveLength(1);
  });

  it('does not block on a worktree whose folder no longer exists', async () => {
    const { clone, addWorktree, root } = makeProject();
    const wt = addWorktree('gone');
    execFileSync('rm', ['-rf', wt]);
    expect(await findUnsavedWork(clone)).toEqual([]);
    expect(root).toBeTruthy();
  });

  it('looks into repos nested one level down, which the parent ignores', async () => {
    const { clone, addWorktree } = makeProject();
    writeFileSync(join(clone, '.gitignore'), 'child/\n');
    git(clone, 'add', '.gitignore');
    git(clone, 'commit', '-q', '-m', 'ignore child');
    git(clone, 'push', '-q', 'origin', 'main');
    const wt = addWorktree('a');
    const child = join(wt, 'child');
    mkdirSync(child);
    const childOrigin = join(mkdtempSync(join(tmpdir(), 'panel-child-')), 'o.git');
    execFileSync('git', ['clone', '-q', '--bare', makeGitRepo(), childOrigin]);
    execFileSync('rm', ['-rf', child]);
    execFileSync('git', ['clone', '-q', childOrigin, child]);
    expect(await findUnsavedWork(clone)).toEqual([]);
    writeFileSync(join(child, 'README.md'), 'edited\n');
    const blockers = await findUnsavedWork(clone);
    expect(blockers).toMatchObject([{ path: child, kind: 'uncommitted' }]);
  });
});
