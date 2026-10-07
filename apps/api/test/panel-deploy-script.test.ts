import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeGitRepo } from './helpers.js';

const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'vm', '12-panel-deploy.sh');
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8',
  }).trim();

/** A clone of a bare origin, plus a second clone to push new commits from. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'panel-deploy-'));
  const seed = makeGitRepo();
  writeFileSync(join(seed, 'package-lock.json'), '{"v":1}\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'lock');
  const origin = join(dir, 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', seed, origin]);
  const repo = join(dir, 'repo');
  const other = join(dir, 'other');
  execFileSync('git', ['clone', '-q', origin, repo]);
  execFileSync('git', ['clone', '-q', origin, other]);

  const bin = join(dir, 'bin');
  const log = join(dir, 'calls.log');
  mkdirSync(bin);
  // The build fails while the repo has a file named BREAK (the commit under test brings it).
  writeFileSync(
    join(bin, 'npm'),
    `#!/usr/bin/env bash
echo "npm $* @ $(git rev-parse --short HEAD)" >> "${log}"
if [ "$1" = run ] && [ -e BREAK ]; then exit 2; fi
exit 0
`,
  );
  chmodSync(join(bin, 'npm'), 0o755);

  const push = (file: string, content = 'x\n') => {
    writeFileSync(join(other, file), content);
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', `add ${file}`);
    git(other, 'push', '-q', 'origin', 'main');
    return git(other, 'rev-parse', '--short', 'HEAD');
  };
  const run = (running?: string) => {
    try {
      const out = execFileSync('bash', [SCRIPT, repo, ...(running ? [running] : [])], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
      });
      return { code: 0, out };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };
  const calls = () => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };
  const head = () => git(repo, 'rev-parse', '--short', 'HEAD');
  const tail = (out: string) => out.trim().split('\n').slice(-3);
  return { repo, push, run, calls, head, tail };
}

describe('12-panel-deploy.sh', () => {
  it('does nothing when main is up to date', () => {
    const { run, calls, head, tail } = sandbox();
    const sha = head();
    const result = run();
    expect(result.code).toBe(0);
    expect(tail(result.out)).toEqual([
      `DEPLOY_FROM=${sha}`,
      `DEPLOY_TO=${sha}`,
      'DEPLOY_RESTART=no',
    ]);
    expect(calls()).toEqual([]);
  });

  it('fast-forwards and builds, without npm ci when the lock did not change', () => {
    const { push, run, calls, head, tail } = sandbox();
    const from = head();
    const to = push('feature.txt');
    const result = run();
    expect(result.code).toBe(0);
    expect(head()).toBe(to);
    expect(tail(result.out)).toEqual([
      `DEPLOY_FROM=${from}`,
      `DEPLOY_TO=${to}`,
      'DEPLOY_RESTART=yes',
    ]);
    expect(calls()).toEqual([`npm run build @ ${to}`]);
    // Second run: nothing new, nothing built.
    expect(tail(run().out).at(-1)).toBe('DEPLOY_RESTART=no');
    expect(calls()).toHaveLength(1);
  });

  it('builds and asks for the restart when the disk is up to date but the service runs an older commit', () => {
    const { repo, push, run, calls, head, tail } = sandbox();
    const running = head();
    const to = push('feature.txt');
    // Someone ran `git pull` without restarting the service.
    git(repo, 'pull', '-q', '--ff-only');
    expect(head()).toBe(to);
    const result = run(running);
    expect(result.code).toBe(0);
    expect(tail(result.out)).toEqual([
      `DEPLOY_FROM=${running}`,
      `DEPLOY_TO=${to}`,
      'DEPLOY_RESTART=yes',
    ]);
    expect(calls()).toEqual([`npm run build @ ${to}`]);
    // Once the service runs it, nothing is left to deploy.
    expect(tail(run(to).out).at(-1)).toBe('DEPLOY_RESTART=no');
  });

  it('runs npm ci when package-lock.json changed', () => {
    const { push, run, calls } = sandbox();
    const to = push('package-lock.json', '{"v":2}\n');
    expect(run().code).toBe(0);
    expect(calls()).toEqual([`npm ci --include=dev --no-audit --no-fund @ ${to}`, `npm run build @ ${to}`]);
  });

  it('refuses with local changes or off main, without touching anything', () => {
    const dirty = sandbox();
    dirty.push('feature.txt');
    const before = dirty.head();
    writeFileSync(join(dirty.repo, 'scratch.txt'), 'wip\n');
    const result = dirty.run();
    expect(result.code).toBe(1);
    expect(result.out).toContain('cambios locales');
    expect(dirty.head()).toBe(before);
    expect(dirty.calls()).toEqual([]);

    const branch = sandbox();
    git(branch.repo, 'checkout', '-q', '-b', 'feature/x');
    const off = branch.run();
    expect(off.code).toBe(1);
    expect(off.out).toContain('no en main');
  });

  it('refuses when local main has commits origin does not have', () => {
    const { repo, push, run, head, calls } = sandbox();
    push('feature.txt');
    writeFileSync(join(repo, 'local.txt'), 'local\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'local');
    const before = head();
    const result = run();
    expect(result.code).toBe(1);
    expect(result.out).toContain('commits que origin/main no tiene');
    expect(head()).toBe(before);
    expect(calls()).toEqual([]);
  });

  it('goes back to the previous commit and rebuilds it when the build fails', () => {
    const { push, run, calls, head } = sandbox();
    const from = head();
    const to = push('BREAK');
    const result = run();
    expect(result.code).toBe(1);
    expect(head()).toBe(from);
    // stdout goes before stderr in `out`: the lines are checked one by one.
    for (const line of [`DEPLOY_FROM=${from}`, `DEPLOY_TO=${from}`, 'DEPLOY_RESTART=no'])
      expect(result.out).toContain(line);
    expect(calls()).toEqual([`npm run build @ ${to}`, `npm run build @ ${from}`]);
  });
});
