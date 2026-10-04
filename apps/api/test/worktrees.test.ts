import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project } from '@agents-panel/shared';
import { WorktreeError, createWorktree, splitCommand } from '../src/worktrees/create.js';
import { makeGitRepo } from './helpers.js';

function setup(setupCommand: string | null = null) {
  const repoPath = makeGitRepo();
  const root = mkdtempSync(join(tmpdir(), 'panel-wt-'));
  const project: Project = {
    id: 1,
    name: 'demo',
    displayName: null,
    repoUrl: null,
    repoPath,
    baseBranch: 'main',
    setupCommand,
    status: 'ready',
    statusDetail: null,
    hasKyro: false,
    kyroWarning: null,
  };
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' });
  return { project, root, git };
}

describe('createWorktree', () => {
  it('creates <root>/<project>/<slug> on feature/<slug>', async () => {
    const { project, root, git } = setup();
    const result = await createWorktree(project, 'my-fix', root);
    expect(result).toEqual({ path: join(root, 'demo', 'my-fix'), branch: 'feature/my-fix' });
    expect(existsSync(join(result.path, 'README.md'))).toBe(true);
    expect(git('rev-parse', '--abbrev-ref', 'feature/my-fix').trim()).toBe('feature/my-fix');
    expect(
      execFileSync('git', ['-C', result.path, 'branch', '--show-current'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('feature/my-fix');
  });

  it('rejects invalid slugs without leaving anything behind', async () => {
    const { project, root, git } = setup();
    for (const slug of ['Bad Slug', '../escape', 'a'.repeat(51), '', 'trailing-', 'x;rm -rf']) {
      await expect(createWorktree(project, slug, root)).rejects.toBeInstanceOf(WorktreeError);
    }
    expect(git('branch', '--list', 'feature/*').trim()).toBe('');
    expect(existsSync(join(root, 'demo'))).toBe(false);
  });

  it('rejects an existing branch and keeps it untouched', async () => {
    const { project, root, git } = setup();
    git('branch', 'feature/taken');
    await expect(createWorktree(project, 'taken', root)).rejects.toThrow(/already exists/);
    expect(git('branch', '--list', 'feature/taken')).toContain('feature/taken');
    expect(existsSync(join(root, 'demo', 'taken'))).toBe(false);
  });

  it('runs setup_command inside the worktree and logs its output', async () => {
    const { project, root } = setup('git config --local panel.setup done');
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const result = await createWorktree(project, 'with-setup', root, (type, payload) =>
      events.push({ type, payload }),
    );
    const out = execFileSync('git', ['-C', result.path, 'config', '--local', 'panel.setup'], {
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('done');
    expect(events.map((e) => e.payload['step'])).toEqual(['git worktree add', 'setup']);
  });

  it('rolls back worktree and branch when setup fails, and reports the error as an event', async () => {
    const { project, root, git } = setup('git definitely-not-a-command');
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    await expect(
      createWorktree(project, 'will-fail', root, (type, payload) => events.push({ type, payload })),
    ).rejects.toThrow(/setup failed/);
    expect(existsSync(join(root, 'demo', 'will-fail'))).toBe(false);
    expect(git('branch', '--list', 'feature/will-fail').trim()).toBe('');
    expect(git('worktree', 'list').trim().split('\n')).toHaveLength(1);
    const last = events.at(-1);
    expect(last?.type).toBe('worktree_output');
    expect(last?.payload['step']).toBe('setup');
    expect(String(last?.payload['stderr'])).not.toBe('');
  });

  it('does not interpret shell syntax in setup_command or in slugs', async () => {
    const { project, root } = setup('echo hi; touch pwned');
    const result = await createWorktree(project, 'no-shell', root);
    expect(existsSync(join(result.path, 'pwned'))).toBe(false);
  });
});

describe('splitCommand', () => {
  it('splits words and honours quotes without a shell', () => {
    expect(splitCommand(`npm ci --prefix "a b" 'c d'`)).toEqual([
      'npm',
      'ci',
      '--prefix',
      'a b',
      'c d',
    ]);
    expect(() => splitCommand('echo "oops')).toThrow(WorktreeError);
  });
});

it('does not use a shell anywhere in src/worktrees', () => {
  const source = readFileSync(join(import.meta.dirname, '../src/worktrees/create.ts'), 'utf8');
  expect(source).not.toMatch(/shell\s*:\s*true/);
  expect(source).not.toMatch(/\bexec\(|\bexecSync\(|\bspawn\(/);
});
