import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitKyroToBase } from '../src/maintenance/kyro-commit.js';
import { makeGitRepo } from './helpers.js';

const PROJECT_JSON = '.agents/kyro/project.json';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8',
  }).trim();
}

/** A base clone on `main` that ships Kyro, with a bare origin and a second clone of it. */
function setup() {
  const repo = makeGitRepo();
  mkdirSync(join(repo, '.agents', 'kyro'), { recursive: true });
  writeFileSync(join(repo, PROJECT_JSON), '{ "schemaVersion": 4 }\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'chore: kyro');
  const remote = join(mkdtempSync(join(tmpdir(), 'panel-remote-')), 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
  const remoteHead = () => git(remote, 'rev-parse', 'main');
  const kyroUpdate = () => {
    writeFileSync(join(repo, PROJECT_JSON), '{ "schemaVersion": 5 }\n');
    writeFileSync(join(repo, '.agents', 'kyro', 'nuevo.json'), '{}\n');
  };
  return { repo, remote, remoteHead, kyroUpdate };
}

beforeEach(() => {
  // The module runs plain `git commit`: give it an identity without touching the global config.
  vi.stubEnv('GIT_AUTHOR_NAME', 't');
  vi.stubEnv('GIT_AUTHOR_EMAIL', 't@t');
  vi.stubEnv('GIT_COMMITTER_NAME', 't');
  vi.stubEnv('GIT_COMMITTER_EMAIL', 't@t');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('commitKyroToBase', () => {
  it('commits only .agents/kyro/ and pushes it to the base branch', async () => {
    const { repo, remoteHead, kyroUpdate } = setup();
    kyroUpdate();
    writeFileSync(join(repo, 'ajeno.txt'), 'no es de kyro\n');

    const outcome = await commitKyroToBase({ repoPath: repo, baseBranch: 'main' }, '6.5.0');

    expect(outcome).toMatchObject({ status: 'committed' });
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(outcome).toEqual({ status: 'committed', commit: head });
    expect(remoteHead()).toBe(head);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('chore(kyro): actualizar Kyro a 6.5.0');
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([
      '.agents/kyro/nuevo.json',
      PROJECT_JSON,
    ]);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    // Only the foreign untracked file is left.
    expect(git(repo, 'status', '--porcelain')).toBe('?? ajeno.txt');
  });

  it('does nothing when .agents/kyro/ has no changes', async () => {
    const { repo, remoteHead } = setup();
    const before = remoteHead();
    expect(await commitKyroToBase({ repoPath: repo, baseBranch: 'main' }, '6.5.0')).toEqual({
      status: 'unchanged',
    });
    expect(remoteHead()).toBe(before);
  });

  it('brings origin in by fast-forward before committing', async () => {
    const { repo, remote, remoteHead, kyroUpdate } = setup();
    const other = mkdtempSync(join(tmpdir(), 'panel-other-'));
    execFileSync('git', ['clone', '-q', remote, other]);
    writeFileSync(join(other, 'otro.txt'), 'x\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'feat: otro');
    git(other, 'push', '-q', 'origin', 'main');
    const upstream = remoteHead();
    kyroUpdate();

    const outcome = await commitKyroToBase({ repoPath: repo, baseBranch: 'main' }, null);

    expect(outcome.status).toBe('committed');
    expect(git(repo, 'rev-parse', 'HEAD~1')).toBe(upstream);
    expect(remoteHead()).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('chore(kyro): actualizar Kyro');
  });

  it('refuses a clone on another branch and leaves the changes as they were', async () => {
    const { repo, remoteHead, kyroUpdate } = setup();
    git(repo, 'checkout', '-q', '-b', 'feature/x');
    kyroUpdate();
    const before = git(repo, 'rev-parse', 'HEAD');
    const remoteBefore = remoteHead();

    const outcome = await commitKyroToBase({ repoPath: repo, baseBranch: 'main' }, '6.5.0');

    expect(outcome).toMatchObject({ status: 'failed' });
    expect(outcome.status === 'failed' && outcome.reason).toContain('feature/x');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(remoteHead()).toBe(remoteBefore);
    expect(readFileSync(join(repo, PROJECT_JSON), 'utf8')).toContain('5');
  });

  it('refuses a clone with its own unpushed commits, so they never reach origin', async () => {
    const { repo, remoteHead, kyroUpdate } = setup();
    writeFileSync(join(repo, 'local.txt'), 'x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'feat: local');
    kyroUpdate();
    const remoteBefore = remoteHead();

    const outcome = await commitKyroToBase({ repoPath: repo, baseBranch: 'main' }, '6.5.0');

    expect(outcome).toMatchObject({ status: 'failed' });
    expect(outcome.status === 'failed' && outcome.reason).toContain('sin pushear');
    expect(remoteHead()).toBe(remoteBefore);
  });

  it('undoes its own commit when the push is rejected (protected branch)', async () => {
    const { repo, remote, remoteHead, kyroUpdate } = setup();
    const hook = join(remote, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/usr/bin/env bash\necho "protected branch" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    kyroUpdate();
    const before = git(repo, 'rev-parse', 'HEAD');
    const remoteBefore = remoteHead();

    const outcome = await commitKyroToBase({ repoPath: repo, baseBranch: 'main' }, '6.5.0');

    expect(outcome).toMatchObject({ status: 'failed' });
    expect(outcome.status === 'failed' && outcome.reason).toContain('push rechazado');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(remoteHead()).toBe(remoteBefore);
    // The changes stay in the tree (unstaged) for the next update.
    expect(git(repo, 'diff', '--name-only')).toBe(PROJECT_JSON);
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(repo, 'ls-files', '--others', '--exclude-standard')).toBe('.agents/kyro/nuevo.json');
  });
});
