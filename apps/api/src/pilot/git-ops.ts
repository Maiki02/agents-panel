import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { DiffAgainst, DiffFile, DiffFileStatus } from '@agents-panel/shared';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 60_000;
/** A pull or a push may move real data: more room than a status. */
const GIT_NETWORK_TIMEOUT_MS = 5 * 60_000;

/** Runs a program with argv (no shell); injectable so a test can record every argv. */
export type Exec = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: Exec = (file, args, options) =>
  execFileAsync(file, args, { timeout: options.timeout, maxBuffer: 4 * 1024 * 1024 });

/** The git operations the pilot runs itself (never the agent). Injectable so tests use a fake. */
export interface PilotGit {
  /**
   * Commits only what changed under `.agents/kyro/` (never `git add -A`); `committed` is false
   * when there was nothing to commit. Rejects with the git output when git fails.
   */
  commitKyro(cwd: string, message: string): Promise<{ committed: boolean }>;
  /** Commit HEAD points to. */
  head(cwd: string): Promise<string>;
  /** Commit a local branch points to; '' when the branch does not exist. */
  branchHead(cwd: string, branch: string): Promise<string>;
  /** Pushes the branch to origin (see `pushArgs`); rejects with the trimmed git output. */
  push(cwd: string, branch: string): Promise<void>;
}

/** The git operations of the merge phase (bringing the base in, conflicts, pending work). */
export interface MergeGit {
  /** True when the worktree has changes that are not committed (untracked files included). */
  hasPendingChanges(cwd: string): Promise<boolean>;
  /** Commits everything pending; the pilot only calls it after the secrets scan came out clean. */
  commitPending(cwd: string, message: string): Promise<{ committed: boolean }>;
  /**
   * `git pull --no-rebase origin <base>`: brings the base into the branch as a merge. A conflict
   * is not an error: it is `ok: false` and the caller reads `unmergedPaths`.
   */
  pull(cwd: string, base: string): Promise<{ ok: boolean; output: string }>;
  /** Paths with an unresolved merge (`git diff --diff-filter=U`). */
  unmergedPaths(cwd: string): Promise<string[]>;
  /** True while a merge is open (MERGE_HEAD exists). */
  mergeInProgress(cwd: string): Promise<boolean>;
  /** Name of the checked-out branch ('' when HEAD is detached). */
  currentBranch(cwd: string): Promise<string>;
  /** True when HEAD is already contained in `ref` (the branch reached the base). */
  isAncestor(cwd: string, ref: string): Promise<boolean>;
}

/** One changed path of `git status`: the two-letter porcelain code (index, worktree) and the path. */
export interface GitFileStatus {
  path: string;
  /** Porcelain v1 `XY` code, e.g. ' M', 'A ', '??', 'UU'. */
  status: string;
}

export interface GitStatus {
  /** Checked-out branch ('' when HEAD is detached). */
  branch: string;
  files: GitFileStatus[];
  /** Commits ahead of `origin/<branch>`; null when that remote branch does not exist. */
  ahead: number | null;
  /** Commits behind `origin/<branch>`; null when that remote branch does not exist. */
  behind: number | null;
}

/** The git operations of the manual per-work actions (status, commit of chosen files, pulls). */
export interface RepoGit {
  status(cwd: string): Promise<GitStatus>;
  /** Commits only the given files; rejects bad, outside or ignored paths without committing. */
  commitFiles(cwd: string, files: string[], message: string): Promise<void>;
  /**
   * Discards the changes of the chosen files (D28). Tracked files go back to HEAD; untracked ones
   * are deleted only when `git ls-files --others --exclude-standard` lists them. Everything is
   * checked first: a bad, outside, ignored or unchanged path rejects with `GitInputError` and
   * nothing is touched.
   */
  discardFiles(cwd: string, files: string[]): Promise<void>;
  /** `git pull --no-rebase --no-edit origin <branch>`; rejects with the git output on failure. */
  pullBranch(cwd: string, branch: string): Promise<string>;
  /** `git merge --abort`. */
  abortMerge(cwd: string): Promise<void>;
  /** Paths that differ between two refs. */
  changedFiles(cwd: string, from: string, to: string): Promise<string[]>;
  /** Commits of HEAD that are not in `origin/<base>` (the local base when origin has none). */
  commitsOutside(cwd: string, base: string): Promise<number>;
  /** Subjects of those commits, newest first, merges left out. */
  subjectsOutside(cwd: string, base: string): Promise<string[]>;
  /**
   * Read-only diff (D27). `worktree`: uncommitted changes (`git diff HEAD`) plus the untracked files
   * that are not ignored. `base`: `git diff <base>...HEAD`. Ignored files never show, even when
   * tracked by mistake. With `file`, only that file, with `patchLimit` as its cut. Rejects with
   * `GitInputError` for a path that is absolute, has `..`, is outside the repo or is ignored.
   */
  diff(cwd: string, options: DiffOptions): Promise<{ files: DiffFile[]; moreFiles: boolean }>;
  /** True when origin has the branch (`git ls-remote`); rejects when origin cannot be asked. */
  remoteBranchExists(cwd: string, branch: string): Promise<boolean>;
  /** Commits of the local branch that no branch of origin has. */
  unpushedCommits(cwd: string, branch: string): Promise<number>;
  /**
   * `git push origin --delete <branch>`. The branch is a validated plain name and never `base`
   * (the repo's base branch): the base is not deletable from here.
   */
  deleteRemoteBranch(cwd: string, branch: string, base: string): Promise<void>;
}

export interface DiffOptions {
  against: DiffAgainst;
  base: string;
  file?: string;
  /** Characters kept of each patch. */
  patchLimit: number;
}

/** The caller asked for something the diff refuses (a bad or ignored path): a 400, not a git failure. */
export class GitInputError extends Error {
  override readonly name = 'GitInputError';
}

/** Most files one diff lists; the rest is reported with `moreFiles`. */
const DIFF_FILE_LIMIT = 300;
const IGNORE_CHUNK = 100;

/** Rejects a path that is not a plain relative path inside the repo. */
export function checkRelativePath(cwd: string, file: string): void {
  if (file === '' || file.includes('\0')) throw new GitInputError('Ruta no válida');
  if (isAbsolute(file)) throw new GitInputError('Ruta absoluta no permitida: ' + file);
  if (file.split(/[\\/]/).includes('..')) {
    throw new GitInputError("Ruta con '..' no permitida: " + file);
  }
  const root = resolve(cwd);
  const rel = relative(root, resolve(root, file));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new GitInputError('Ruta fuera del repositorio: ' + file);
  }
}

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function checkBranch(branch: string, what: string): void {
  if (!BRANCH.test(branch) || branch.includes('..')) {
    throw new Error(`Nombre de rama no válido para ${what}: ${branch}`);
  }
}

/**
 * argv of the push. The branch is only ever a plain name: never a refspec (`+`, `:`), an option or
 * a force (R12: pushes are never forced, and rebases of pushed branches do not exist).
 */
export function pushArgs(branch: string): string[] {
  checkBranch(branch, 'el push');
  return ['push', '-u', 'origin', branch];
}

/** argv of the pull: a merge (`--no-rebase`) of origin's base into the current branch (R13). */
export function pullArgs(base: string): string[] {
  checkBranch(base, 'el pull');
  return ['pull', '--no-rebase', '--no-edit', 'origin', base];
}

function failure(args: string[], error: unknown): Error {
  const out = error as { stderr?: unknown; stdout?: unknown; message?: string };
  const text = [out.stderr, out.stdout]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join('\n');
  const detail = text === '' ? (out.message ?? '') : text;
  return new Error(`git ${args[0] ?? ''} falló: ${detail.trim().slice(0, 500)}`, { cause: error });
}

/** The real operations, over an `exec` that tests can replace to see every argv. */
export function createGit(exec: Exec = defaultExec): PilotGit & MergeGit & RepoGit {
  const git = async (cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> => {
    try {
      return (await exec('git', ['-C', cwd, ...args], { timeout })).stdout;
    } catch (error) {
      throw failure(args, error);
    }
  };
  const currentBranch = async (cwd: string): Promise<string> =>
    (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim().replace(/^HEAD$/, '');
  const isIgnored = async (cwd: string, file: string): Promise<boolean> => {
    try {
      await git(cwd, ['check-ignore', '-q', '--', file]);
      return true;
    } catch {
      return false; // exit 1: not ignored
    }
  };
  /** Runs a history command over `origin/<base>..HEAD`, or `<base>..HEAD` when origin has no base. */
  const baseRange = async (cwd: string, base: string, command: string[]): Promise<string> => {
    checkBranch(base, 'el rango');
    try {
      return await git(cwd, [...command, `origin/${base}..HEAD`, '--']);
    } catch {
      return git(cwd, [...command, `${base}..HEAD`, '--']);
    }
  };
  /**
   * Output of a command whose exit code 1 only means "there are differences" (`diff --no-index`),
   * or whose output outgrew the buffer: what it printed is still the answer.
   */
  const gitOutput = async (cwd: string, args: string[]): Promise<string> => {
    try {
      return (await exec('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS })).stdout;
    } catch (error) {
      const out = error as { code?: unknown; stdout?: unknown };
      const partial = typeof out.stdout === 'string' ? out.stdout : null;
      if (
        partial !== null &&
        (out.code === 1 || out.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      ) {
        return partial;
      }
      throw failure(args, error);
    }
  };
  /** The subset of `paths` that git ignores, tracked or not (`--no-index`). */
  const ignoredAmong = async (cwd: string, paths: string[]): Promise<Set<string>> => {
    const ignored = new Set<string>();
    // Exit 1 means "none ignored"; any other failure must not let an ignored file through.
    const check = async (args: string[]): Promise<string> => {
      try {
        return await git(cwd, ['check-ignore', '--no-index', ...args]);
      } catch (error) {
        const code = ((error as Error).cause as { code?: unknown } | undefined)?.code;
        if (code === 1) return '';
        throw error;
      }
    };
    // `-z` only works with --stdin, so the output is quoted for odd names: those are asked one by one.
    const plain = /^[\w./@+=,-]+$/;
    for (let i = 0; i < paths.length; i += IGNORE_CHUNK) {
      const chunk = paths.slice(i, i + IGNORE_CHUNK);
      const simple = chunk.filter((path) => plain.test(path) && !path.startsWith('-'));
      if (simple.length > 0) {
        const out = await check(['--', ...simple]);
        for (const line of out.split('\n')) if (line !== '') ignored.add(line);
      }
      for (const path of chunk) {
        if (simple.includes(path)) continue;
        // `-q` prints nothing: exit 0 is ignored, exit 1 is not (see `check`).
        try {
          await git(cwd, ['check-ignore', '-q', '--no-index', '--', path]);
          ignored.add(path);
        } catch (error) {
          const code = ((error as Error).cause as { code?: unknown } | undefined)?.code;
          if (code !== 1) throw error;
        }
      }
    }
    return ignored;
  };
  const hasRef = async (cwd: string, ref: string): Promise<boolean> => {
    try {
      await git(cwd, ['rev-parse', '--verify', '--quiet', ref]);
      return true;
    } catch {
      return false;
    }
  };
  const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'];
  const STATUS_OF: Record<string, DiffFileStatus> = {
    A: 'added',
    D: 'deleted',
  };
  return {
    async diff(cwd, options) {
      const { against, base, file, patchLimit } = options;
      if (file !== undefined) {
        checkRelativePath(cwd, file);
        if ((await ignoredAmong(cwd, [file])).size > 0) {
          throw new GitInputError('Archivo ignorado por git: ' + file);
        }
      }
      // What to compare and which files changed: tracked ones from git, untracked ones from ls-files.
      let compare: string[];
      if (against === 'base') {
        checkBranch(base, 'el diff');
        const ref = (await hasRef(cwd, `refs/remotes/origin/${base}`)) ? `origin/${base}` : base;
        compare = [`${ref}...HEAD`];
      } else {
        compare = ['HEAD'];
      }
      const entries = new Map<string, { status: DiffFileStatus; untracked: boolean }>();
      const names = (
        await git(cwd, ['diff', ...DIFF_FLAGS, '--name-status', '-z', ...compare, '--'])
      ).split('\0');
      for (let i = 0; i + 1 < names.length; i += 2) {
        const code = names[i] ?? '';
        const path = names[i + 1] ?? '';
        if (path !== '') {
          entries.set(path, { status: STATUS_OF[code.charAt(0)] ?? 'modified', untracked: false });
        }
      }
      if (against === 'worktree') {
        const others = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
        for (const path of others.split('\0')) {
          if (path !== '') entries.set(path, { status: 'untracked', untracked: true });
        }
      }
      let paths = [...entries.keys()].sort();
      if (file !== undefined) paths = paths.filter((p) => p === file);
      const ignored = await ignoredAmong(cwd, paths);
      paths = paths.filter((p) => !ignored.has(p));
      const moreFiles = paths.length > DIFF_FILE_LIMIT;
      paths = paths.slice(0, DIFF_FILE_LIMIT);

      const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
      const numstat = (
        await git(cwd, ['diff', ...DIFF_FLAGS, '--numstat', '-z', ...compare, '--'])
      ).split('\0');
      for (const line of numstat) {
        const [add, del, ...rest] = line.split('\t');
        const path = rest.join('\t');
        if (path === '' || add === undefined || del === undefined) continue;
        const binary = add === '-';
        counts.set(path, {
          additions: binary ? 0 : Number(add),
          deletions: binary ? 0 : Number(del),
          binary,
        });
      }

      const files: DiffFile[] = [];
      for (const path of paths) {
        const entry = entries.get(path);
        if (!entry) continue;
        let patch: string;
        let stat = counts.get(path) ?? { additions: 0, deletions: 0, binary: false };
        if (entry.untracked) {
          const untracked = ['diff', ...DIFF_FLAGS, '--no-index'];
          const numbers = (
            await gitOutput(cwd, [...untracked, '--numstat', '--', '/dev/null', path])
          ).split('\t');
          const binary = numbers[0] === '-';
          stat = { additions: binary ? 0 : Number(numbers[0] ?? 0) || 0, deletions: 0, binary };
          patch = binary ? '' : await gitOutput(cwd, [...untracked, '--', '/dev/null', path]);
        } else {
          patch = stat.binary
            ? ''
            : await gitOutput(cwd, ['diff', ...DIFF_FLAGS, ...compare, '--', path]);
        }
        const truncated = patch.length > patchLimit;
        files.push({
          path,
          status: entry.status,
          additions: stat.additions,
          deletions: stat.deletions,
          binary: stat.binary,
          patch: truncated ? patch.slice(0, patchLimit) : patch,
          truncated,
        });
      }
      return { files, moreFiles };
    },
    async status(cwd) {
      const branch = await currentBranch(cwd);
      const raw = (await git(cwd, ['status', '--porcelain=v1', '-z'])).split('\0');
      const files: GitFileStatus[] = [];
      for (let i = 0; i < raw.length; i++) {
        const entry = raw[i] ?? '';
        if (entry.length < 4) continue;
        const status = entry.slice(0, 2);
        files.push({ status, path: entry.slice(3) });
        if (status.includes('R') || status.includes('C')) i++; // the next entry is the origin path
      }
      let ahead: number | null = null;
      let behind: number | null = null;
      if (branch !== '' && BRANCH.test(branch)) {
        try {
          await git(cwd, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + branch]);
          const counts = (
            await git(cwd, ['rev-list', '--left-right', '--count', 'HEAD...origin/' + branch])
          )
            .trim()
            .split(/\s+/);
          ahead = Number(counts[0]);
          behind = Number(counts[1]);
        } catch {
          // No remote branch: ahead and behind stay null.
        }
      }
      return { branch, files, ahead, behind };
    },
    async commitFiles(cwd, files, message) {
      if (files.length === 0) throw new Error('No hay archivos elegidos para commitear');
      if (message.trim() === '') throw new Error('El mensaje del commit está vacío');
      const root = resolve(cwd);
      for (const file of files) {
        if (file === '' || file.includes('\0')) throw new Error('Ruta no válida');
        if (isAbsolute(file)) throw new Error('Ruta absoluta no permitida: ' + file);
        if (file.split(/[\\/]/).includes('..')) {
          throw new Error("Ruta con '..' no permitida: " + file);
        }
        const rel = relative(root, resolve(root, file));
        if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
          throw new Error('Ruta fuera del repositorio: ' + file);
        }
        if (await isIgnored(cwd, file)) throw new Error('Archivo ignorado por git: ' + file);
      }
      await git(cwd, ['add', '--', ...files]);
      await git(cwd, ['commit', '-m', message, '--', ...files]);
    },
    async discardFiles(cwd, files) {
      if (files.length === 0) throw new GitInputError('No hay archivos elegidos para descartar');
      const unique = [...new Set(files)];
      const listed = async (args: string[]): Promise<Set<string>> =>
        new Set(
          (await git(cwd, [...args, '-z', '--', ...unique])).split('\0').filter((p) => p !== ''),
        );
      for (const file of unique) {
        checkRelativePath(cwd, file);
        if (await isIgnored(cwd, file))
          throw new GitInputError('Archivo ignorado por git: ' + file);
      }
      const tracked = await listed(['ls-files']);
      const untracked = await listed(['ls-files', '--others', '--exclude-standard']);
      const restore: string[] = [];
      const remove: string[] = [];
      const unstage: string[] = [];
      for (const file of unique) {
        if (tracked.has(file)) {
          const changed = await git(cwd, ['status', '--porcelain=v1', '-z', '--', file]);
          if (changed.trim() === '')
            throw new GitInputError('El archivo no tiene cambios: ' + file);
          let inHead = true;
          try {
            await git(cwd, ['cat-file', '-e', 'HEAD:' + file]);
          } catch {
            inHead = false;
          }
          (inHead ? restore : unstage).push(file);
        } else if (untracked.has(file)) {
          remove.push(file);
        } else {
          throw new GitInputError('El archivo no tiene cambios: ' + file);
        }
      }
      if (restore.length > 0) {
        await git(cwd, ['restore', '--staged', '--worktree', '--source=HEAD', '--', ...restore]);
      }
      if (unstage.length > 0) await git(cwd, ['rm', '-f', '--', ...unstage]);
      const root = resolve(cwd);
      for (const file of remove) await rm(resolve(root, file), { force: true });
    },
    async pullBranch(cwd, branch) {
      const out = await git(cwd, pullArgs(branch), GIT_NETWORK_TIMEOUT_MS);
      return out.trim().slice(0, 2000);
    },
    async abortMerge(cwd) {
      await git(cwd, ['merge', '--abort']);
    },
    async changedFiles(cwd, from, to) {
      checkBranch(from, 'el diff');
      checkBranch(to, 'el diff');
      const out = await git(cwd, ['diff', '--name-only', '-z', from, to, '--']);
      return out.split('\0').filter((file) => file !== '');
    },
    async commitsOutside(cwd, base) {
      return Number((await baseRange(cwd, base, ['rev-list', '--count'])).trim());
    },
    async subjectsOutside(cwd, base) {
      const out = await baseRange(cwd, base, ['log', '--no-merges', '--format=%s']);
      return out.split('\n').filter((line) => line.trim() !== '');
    },
    async commitKyro(cwd, message) {
      if (!existsSync(join(cwd, '.agents', 'kyro'))) return { committed: false };
      await git(cwd, ['add', '--', '.agents/kyro']);
      const staged = await git(cwd, ['diff', '--cached', '--name-only', '--', '.agents/kyro']);
      if (staged.trim() === '') return { committed: false };
      // The pathspec keeps anything else the agent staged out of this commit.
      await git(cwd, ['commit', '-m', message, '--', '.agents/kyro']);
      return { committed: true };
    },
    async head(cwd) {
      return (await git(cwd, ['rev-parse', 'HEAD'])).trim();
    },
    async branchHead(cwd, branch) {
      try {
        return (
          await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
        ).trim();
      } catch {
        return '';
      }
    },
    async push(cwd, branch) {
      await git(cwd, pushArgs(branch), GIT_NETWORK_TIMEOUT_MS);
    },
    async remoteBranchExists(cwd, branch) {
      checkBranch(branch, 'la consulta del remoto');
      try {
        const out = await git(
          cwd,
          ['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`],
          GIT_NETWORK_TIMEOUT_MS,
        );
        return out.trim() !== '';
      } catch (error) {
        // Exit 2 with --exit-code: origin answered and has no such branch.
        const code = ((error as Error).cause as { code?: unknown } | undefined)?.code;
        if (code === 2) return false;
        throw error;
      }
    },
    async unpushedCommits(cwd, branch) {
      checkBranch(branch, 'el conteo');
      const out = await git(cwd, [
        'rev-list',
        '--count',
        `refs/heads/${branch}`,
        '--not',
        '--remotes=origin',
        '--',
      ]);
      return Number(out.trim());
    },
    async deleteRemoteBranch(cwd, branch, base) {
      checkBranch(branch, 'el borrado remoto');
      if (branch === base) throw new Error(`No se borra la rama base en origin: ${base}`);
      await git(cwd, ['push', 'origin', '--delete', branch], GIT_NETWORK_TIMEOUT_MS);
    },
    async hasPendingChanges(cwd) {
      return (await git(cwd, ['status', '--porcelain'])).trim() !== '';
    },
    async commitPending(cwd, message) {
      await git(cwd, ['add', '-A']);
      if ((await git(cwd, ['diff', '--cached', '--name-only'])).trim() === '') {
        return { committed: false };
      }
      await git(cwd, ['commit', '-m', message]);
      return { committed: true };
    },
    async pull(cwd, base) {
      try {
        const out = await git(cwd, pullArgs(base), GIT_NETWORK_TIMEOUT_MS);
        return { ok: true, output: out.trim().slice(0, 2000) };
      } catch (error) {
        return { ok: false, output: error instanceof Error ? error.message : 'git pull falló' };
      }
    },
    async unmergedPaths(cwd) {
      const out = await git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z']);
      return out.split('\0').filter((file) => file !== '');
    },
    currentBranch,
    async isAncestor(cwd, ref) {
      try {
        await git(cwd, ['merge-base', '--is-ancestor', 'HEAD', ref]);
        return true;
      } catch {
        return false;
      }
    },
    async mergeInProgress(cwd) {
      try {
        await git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export const realGit: PilotGit & MergeGit & RepoGit = createGit();
