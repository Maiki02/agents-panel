import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvFileError } from '../src/env-files/validate.js';
import { writeEnvFiles } from '../src/env-files/write.js';
import { makeGitRepo } from './helpers.js';

const SENTINEL = 'S3NT1NEL_WRITE_VALUE_41bc';

/** A real worktree of a temp repo whose committed .gitignore ignores /.env* and backend/.env. */
function makeWorktree(): string {
  const repo = makeGitRepo();
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      stdio: 'pipe',
    });
  writeFileSync(join(repo, '.gitignore'), '/.env*\nbackend/.env\nlink/.env\n');
  git('add', '.gitignore');
  git('commit', '-q', '-m', 'ignore env');
  const worktree = join(mkdtempSync(join(tmpdir(), 'panel-wt-env-')), 'wt');
  git('worktree', 'add', '-q', '-b', 'feature', worktree);
  return worktree;
}

function status(worktree: string): string {
  return execFileSync('git', ['-C', worktree, 'status', '--porcelain'], {
    encoding: 'utf8',
  });
}

function mode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

async function expectEnvError(promise: Promise<void>, message?: string): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EnvFileError);
  const text = (error as EnvFileError).message;
  if (message !== undefined) expect(text).toBe(message);
  expect(text).not.toContain(SENTINEL);
}

/** No .env (nor leftover temp file) anywhere in the worktree outside .git. */
function envFilesIn(worktree: string): string[] {
  return readdirSync(worktree, { recursive: true, encoding: 'utf8' }).filter(
    (entry) => !entry.startsWith('.git') && /(^|\/)\.env/.test(entry),
  );
}

describe('writeEnvFiles', () => {
  it('writes .env and backend/.env with mode 600 and leaves git status clean', async () => {
    const worktree = makeWorktree();
    mkdirSync(join(worktree, 'backend'));
    await writeEnvFiles(worktree, [
      { path: '.env', content: `A=${SENTINEL}\n` },
      { path: 'backend/.env', content: 'B=1\n' },
    ]);
    expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe(`A=${SENTINEL}\n`);
    expect(mode(join(worktree, '.env'))).toBe(0o600);
    expect(mode(join(worktree, 'backend', '.env'))).toBe(0o600);
    expect(status(worktree)).toBe('');
    expect(envFilesIn(worktree).sort()).toEqual(['.env', 'backend/.env']);
  });

  it('replaces an existing file and keeps mode 600', async () => {
    const worktree = makeWorktree();
    writeFileSync(join(worktree, '.env'), 'OLD=1\n', { mode: 0o644 });
    await writeEnvFiles(worktree, [{ path: '.env', content: 'NEW=1\n' }]);
    expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe('NEW=1\n');
    expect(mode(join(worktree, '.env'))).toBe(0o600);
  });

  it('fails when the target folder is missing and writes nothing', async () => {
    const worktree = makeWorktree();
    await expectEnvError(
      writeEnvFiles(worktree, [
        { path: '.env', content: 'A=1\n' },
        { path: 'backend/.env', content: 'B=1\n' },
      ]),
      'falta la carpeta backend para backend/.env',
    );
    expect(envFilesIn(worktree)).toEqual([]);
  });

  it('refuses a target folder that is a symlink out of the worktree', async () => {
    const worktree = makeWorktree();
    const outside = mkdtempSync(join(tmpdir(), 'panel-outside-'));
    symlinkSync(outside, join(worktree, 'link'));
    await expectEnvError(writeEnvFiles(worktree, [{ path: 'link/.env', content: 'A=1\n' }]));
    expect(readdirSync(outside)).toEqual([]);
  });

  it('replaces a symlink at the target with a regular 600 file, leaving its target untouched', async () => {
    const worktree = makeWorktree();
    const outside = join(mkdtempSync(join(tmpdir(), 'panel-outside-')), 'target.txt');
    writeFileSync(outside, 'ORIGINAL\n', { mode: 0o644 });
    symlinkSync(outside, join(worktree, '.env'));

    await writeEnvFiles(worktree, [{ path: '.env', content: 'A=1\n' }]);
    const stats = lstatSync(join(worktree, '.env'));
    expect(stats.isSymbolicLink()).toBe(false);
    expect(stats.isFile()).toBe(true);
    expect(mode(join(worktree, '.env'))).toBe(0o600);
    expect(readFileSync(outside, 'utf8')).toBe('ORIGINAL\n');
    expect(mode(outside)).toBe(0o644);
  });

  it('refuses a path git does not ignore in the worktree and writes nothing', async () => {
    const worktree = makeWorktree();
    mkdirSync(join(worktree, 'config'));
    await expectEnvError(
      writeEnvFiles(worktree, [
        { path: '.env', content: 'A=1\n' },
        { path: 'config/.env', content: 'C=1\n' },
      ]),
    );
    expect(envFilesIn(worktree)).toEqual([]);
  });

  it('refuses the whole list when one file is unreadable', async () => {
    const worktree = makeWorktree();
    mkdirSync(join(worktree, 'backend'));
    await expectEnvError(
      writeEnvFiles(worktree, [
        { path: '.env', content: `A=${SENTINEL}\n` },
        { path: 'backend/.env', unreadable: true },
      ]),
      'el .env backend/.env está ilegible, volvé a subirlo',
    );
    expect(envFilesIn(worktree)).toEqual([]);
  });

  it('revalidates paths before writing', async () => {
    const worktree = makeWorktree();
    await expectEnvError(writeEnvFiles(worktree, [{ path: '../.env', content: 'A=1\n' }]));
    expect(existsSync(join(worktree, '..', '.env'))).toBe(false);
  });
});
