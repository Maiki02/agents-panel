import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pushArgs, realGit } from '../src/pilot/git-ops.js';
import { makeGitRepo, makeRepoWithRemote } from './helpers.js';

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8',
  });

describe('realGit.commitKyro', () => {
  it('commits only .agents/kyro/ and leaves other changes and staged files out', async () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, '.agents/kyro'), { recursive: true });
    writeFileSync(join(repo, '.agents/kyro/project.json'), '{}');
    writeFileSync(join(repo, 'otro.txt'), 'x');
    git(repo, 'add', 'otro.txt');
    const result = await realGit.commitKyro(repo, 'chore(kyro): completar scope demo');
    expect(result).toEqual({ committed: true });
    expect(git(repo, 'show', '--name-only', '--format=%s', 'HEAD').trim().split('\n')).toEqual([
      'chore(kyro): completar scope demo',
      '',
      '.agents/kyro/project.json',
    ]);
    expect(git(repo, 'status', '--porcelain').trim()).toBe('A  otro.txt');
  });

  it('does nothing when .agents/kyro/ has no changes', async () => {
    const repo = makeGitRepo();
    expect(await realGit.commitKyro(repo, 'chore(kyro): nada')).toEqual({ committed: false });
  });

  it('rejects with the git output when git fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
    mkdirSync(join(dir, '.agents/kyro'), { recursive: true });
    await expect(realGit.commitKyro(dir, 'x')).rejects.toThrow(/git add falló/);
  });
});

describe('realGit push', () => {
  /** A repo with a bare local remote as origin and a feature branch with a commit. */
  function withRemote() {
    const repo = makeGitRepo();
    const remote = mkdtempSync(join(tmpdir(), 'panel-remote-')) + '/origin.git';
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'checkout', '-q', '-b', 'feature/x');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'feat: a');
    const remoteRef = (ref: string) =>
      execFileSync('git', ['-C', remote, 'rev-parse', '--verify', '--quiet', ref], {
        encoding: 'utf8',
      }).trim();
    return { repo, remote, remoteRef };
  }

  it('builds an argv without force, force-with-lease or refspecs', () => {
    expect(pushArgs('feature/x')).toEqual(['push', '-u', 'origin', 'feature/x']);
    for (const bad of [
      '+feature/x',
      'a:b',
      '--force',
      '-f',
      'a..b',
      '',
      'feature x',
      'feature/x\n',
    ]) {
      expect(() => pushArgs(bad), bad).toThrow(/no válido/);
    }
    expect(pushArgs('feature/x').join(' ')).not.toMatch(/force|\+|rebase/);
  });

  it('pushes the branch to origin and leaves the base of the remote as it was', async () => {
    const { repo, remoteRef } = withRemote();
    const baseBefore = remoteRef('refs/heads/main');
    await realGit.push(repo, 'feature/x');
    expect(remoteRef('refs/heads/feature/x')).toBe(await realGit.head(repo));
    expect(remoteRef('refs/heads/main')).toBe(baseBefore);
    expect(await realGit.branchHead(repo, 'main')).toBe(baseBefore);
    expect(await realGit.branchHead(repo, 'no-existe')).toBe('');
  });

  it('is rejected when the remote is ahead, with the output, and never retries with --force', async () => {
    const { repo, remote, remoteRef } = withRemote();
    await realGit.push(repo, 'feature/x');
    // Someone else pushes to the same branch: the local one is now behind and diverged.
    const other = mkdtempSync(join(tmpdir(), 'panel-other-'));
    execFileSync('git', ['clone', '-q', remote, other]);
    git(other, 'checkout', '-q', 'feature/x');
    writeFileSync(join(other, 'b.txt'), 'b');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'feat: b');
    git(other, 'push', '-q', 'origin', 'feature/x');
    const remoteHead = remoteRef('refs/heads/feature/x');
    writeFileSync(join(repo, 'c.txt'), 'c');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'feat: c');

    await expect(realGit.push(repo, 'feature/x')).rejects.toThrow(/git push falló/);
    expect(remoteRef('refs/heads/feature/x')).toBe(remoteHead);
  });

  it('fails with git output when the worktree has no remote', async () => {
    const repo = makeGitRepo();
    await expect(realGit.push(repo, 'main')).rejects.toThrow(/git push falló/);
  });
});

describe('realGit repo operations', () => {
  it('status reports branch, files and ahead/behind, null without a remote branch', async () => {
    const { repo, pushFromOther } = makeRepoWithRemote();
    writeFileSync(join(repo, 'new.txt'), 'n');
    writeFileSync(join(repo, 'a.txt'), 'changed');
    let st = await realGit.status(repo);
    expect(st.branch).toBe('feature/x');
    expect(st.ahead).toBeNull();
    expect(st.behind).toBeNull();
    expect(st.files).toEqual(
      expect.arrayContaining([
        { status: ' M', path: 'a.txt' },
        { status: '??', path: 'new.txt' },
      ]),
    );
    await realGit.push(repo, 'feature/x');
    pushFromOther('b.txt', 'b');
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'chore: local');
    st = await realGit.status(repo);
    expect(st.ahead).toBe(1);
    expect(st.behind).toBe(1);
  });

  it('commitFiles commits only the chosen file and leaves the other pending', async () => {
    const { repo } = makeRepoWithRemote();
    writeFileSync(join(repo, 'one.txt'), '1');
    writeFileSync(join(repo, 'two.txt'), '2');
    await realGit.commitFiles(repo, ['one.txt'], 'feat: one');
    expect(git(repo, 'show', '--name-only', '--format=%s', 'HEAD').trim().split('\n')).toEqual([
      'feat: one',
      '',
      'one.txt',
    ]);
    expect(git(repo, 'status', '--porcelain').trim()).toBe('?? two.txt');
  });

  it('commitFiles rejects empty, absolute, .., outside and ignored paths without committing', async () => {
    const { repo } = makeRepoWithRemote();
    writeFileSync(join(repo, '.gitignore'), '.env\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-q', '-m', 'chore: ignore');
    writeFileSync(join(repo, '.env'), 'S=1');
    writeFileSync(join(repo, 'ok.txt'), 'ok');
    const head = await realGit.head(repo);
    await expect(realGit.commitFiles(repo, [], 'm')).rejects.toThrow();
    await expect(realGit.commitFiles(repo, ['../x'], 'm')).rejects.toThrow(/\.\./);
    await expect(realGit.commitFiles(repo, ['sub/../../x'], 'm')).rejects.toThrow();
    await expect(realGit.commitFiles(repo, [join(repo, 'ok.txt')], 'm')).rejects.toThrow(
      /absoluta/,
    );
    await expect(realGit.commitFiles(repo, ['ok.txt', '.env'], 'm')).rejects.toThrow(/ignorado/);
    expect(await realGit.head(repo)).toBe(head);
    expect(git(repo, 'diff', '--cached', '--name-only').trim()).toBe('');
  });

  it('pullBranch brings a pushed commit and rejects option-like or spaced names', async () => {
    const { repo, pushFromOther } = makeRepoWithRemote();
    await realGit.push(repo, 'feature/x');
    pushFromOther('b.txt', 'b');
    await realGit.pullBranch(repo, 'feature/x');
    expect(git(repo, 'ls-files').split('\n')).toContain('b.txt');
    await expect(realGit.pullBranch(repo, '--upload-pack=x')).rejects.toThrow(/no válido/);
    await expect(realGit.pullBranch(repo, 'a b')).rejects.toThrow(/no válido/);
  });

  it('abortMerge closes a conflicted merge and changedFiles lists differences', async () => {
    const { repo, pushFromOther } = makeRepoWithRemote();
    await realGit.push(repo, 'feature/x');
    pushFromOther('a.txt', 'remote');
    writeFileSync(join(repo, 'a.txt'), 'local');
    git(repo, 'commit', '-q', '-am', 'feat: local a');
    await expect(realGit.pullBranch(repo, 'feature/x')).rejects.toThrow(/git pull falló/);
    expect(await realGit.mergeInProgress(repo)).toBe(true);
    await realGit.abortMerge(repo);
    expect(await realGit.mergeInProgress(repo)).toBe(false);
    expect(await realGit.changedFiles(repo, 'main', 'feature/x')).toEqual(['a.txt']);
  });
});
