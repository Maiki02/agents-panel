import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { skippedRoots } from '../src/maintenance/runs.js';
import { makeGitRepo } from './helpers.js';

const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'vm', '08-kyro-update.sh');
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8',
  }).trim();

/** A repo that already ships Kyro, committed, like a project the panel manages. */
function kyroRepo(): string {
  const repo = makeGitRepo();
  mkdirSync(join(repo, '.agents', 'kyro'), { recursive: true });
  writeFileSync(join(repo, '.agents', 'kyro', 'project.json'), '{"v":1}\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'kyro');
  return repo;
}

/** Fake `npm` and `kyro` that only log what they were asked to do, plus a fake HOME with skills. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'panel-kscript-'));
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  const log = join(dir, 'calls.log');
  mkdirSync(bin);
  mkdirSync(join(home, '.agents', 'skills', 'kyro-forge'), { recursive: true });
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('npm', `echo "npm $*" >> "${log}"`);
  stub(
    'kyro',
    `case "$1" in
  --version) echo 9.9.9 ;;
  update) echo "kyro update in $PWD" >> "${log}" ;;
  doctor) echo doctor-ok ;;
esac`,
  );
  const run = (roots: string[]) => {
    try {
      const out = execFileSync('bash', [SCRIPT, ...roots], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
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
  return { run, calls, home };
}

describe('08-kyro-update.sh', () => {
  it('always runs the global update, with or without roots', () => {
    const { run, calls } = sandbox();
    const result = run([]);
    expect(result.code).toBe(0);
    expect(calls()).toEqual(['npm i -g kyro-ai@latest']);
    expect(result.out.trim().split('\n').at(-1)).toBe('KYRO_VERSION=9.9.9');
  });

  it('updates a clean root and a root whose only change is inside .agents/kyro/', () => {
    const { run, calls } = sandbox();
    const clean = kyroRepo();
    const kyroOnly = kyroRepo();
    writeFileSync(join(kyroOnly, '.agents', 'kyro', 'project.json'), '{"v":2}\n');
    writeFileSync(join(kyroOnly, '.agents', 'kyro', 'extra.txt'), 'new\n');
    const result = run([clean, kyroOnly]);
    expect(result.code).toBe(0);
    expect(calls().filter((l) => l.startsWith('kyro update'))).toHaveLength(2);
    expect(result.out).not.toContain('KYRO_SKIPPED');
  });

  it('skips a root with local changes outside .agents/kyro/ and reports it, still updating the others', () => {
    const { run, calls } = sandbox();
    const clean = kyroRepo();
    const dirty = kyroRepo();
    writeFileSync(join(dirty, 'README.md'), 'edited\n');
    const untracked = kyroRepo();
    writeFileSync(join(untracked, 'scratch.txt'), 'x\n');
    const result = run([dirty, clean, untracked]);
    expect(result.code).toBe(0);
    const updates = calls().filter((l) => l.startsWith('kyro update'));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain(clean.replace(/^\/private/, ''));
    expect(result.out).toContain('se saltea');
    const lines = result.out.trim().split('\n');
    expect(lines.at(-1)).toBe('KYRO_VERSION=9.9.9');
    expect(skippedRoots(result.out)).toEqual([dirty, untracked]);
    expect(lines.indexOf(`KYRO_SKIPPED=${dirty}`)).toBeLessThan(lines.length - 1);
    // Nothing was touched in the skipped repos.
    expect(git(dirty, 'status', '--porcelain')).toBe('M README.md');
  });

  it('refuses a root without .agents/kyro/ before touching anything', () => {
    const { run, calls } = sandbox();
    const result = run([makeGitRepo()]);
    expect(result.code).toBe(1);
    expect(calls()).toEqual([]);
  });
});

describe('skippedRoots', () => {
  it('reads the KYRO_SKIPPED lines and nothing else', () => {
    const output =
      'x\nKYRO_SKIPPED=/p/a\nmid KYRO_SKIPPED=/no\nKYRO_SKIPPED=/p/b c\nKYRO_VERSION=1.0.0\n';
    expect(skippedRoots(output)).toEqual(['/p/a', '/p/b c']);
    expect(skippedRoots(null)).toEqual([]);
    expect(skippedRoots('')).toEqual([]);
  });
});
