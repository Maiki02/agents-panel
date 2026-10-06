import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';

export const ORIGIN = 'http://localhost:4200';

export const TEST_ENV = {
  PANEL_SECRET_KEY: 'test-secret-key-test-secret-key-0000',
  PANEL_ORIGIN: 'http://localhost:4200',
  PANEL_DATA_DIR: '/tmp/unused',
};

export function makeApp(
  overrides: Record<string, string> = {},
  now?: () => number,
  extra: Partial<
    Pick<
      AppDeps,
      | 'runner'
      | 'db'
      | 'bus'
      | 'heartbeatMs'
      | 'projectService'
      | 'manager'
      | 'kyroVersions'
      | 'kyroScriptRunner'
      | 'kyroInstaller'
      | 'pilotKyro'
      | 'kyroRunner'
      | 'pilotGit'
      | 'pilotGh'
      | 'pushSender'
      | 'accountsHome'
    >
  > = {},
): {
  app: FastifyInstance;
  db: ReturnType<typeof openDatabase>;
  worktreesDir: string;
  projectsDir: string;
} {
  const db = extra.db ?? openDatabase(':memory:');
  const worktreesDir = mkdtempSync(join(tmpdir(), 'panel-wt-'));
  const projectsDir = mkdtempSync(join(tmpdir(), 'panel-projects-'));
  const config = loadConfig({
    ...TEST_ENV,
    PANEL_WORKTREES_DIR: worktreesDir,
    PANEL_PROJECTS_DIR: projectsDir,
    ...overrides,
  });
  const app = buildApp({
    config,
    db,
    ...(now ? { now } : {}),
    ...(extra.runner ? { runner: extra.runner } : {}),
    ...(extra.bus ? { bus: extra.bus } : {}),
    ...(extra.heartbeatMs ? { heartbeatMs: extra.heartbeatMs } : {}),
    ...(extra.projectService ? { projectService: extra.projectService } : {}),
    ...(extra.manager ? { manager: extra.manager } : {}),
    ...(extra.kyroVersions ? { kyroVersions: extra.kyroVersions } : {}),
    ...(extra.kyroScriptRunner ? { kyroScriptRunner: extra.kyroScriptRunner } : {}),
    ...(extra.kyroInstaller ? { kyroInstaller: extra.kyroInstaller } : {}),
    ...(extra.pilotKyro ? { pilotKyro: extra.pilotKyro } : {}),
    ...(extra.kyroRunner ? { kyroRunner: extra.kyroRunner } : {}),
    ...(extra.pilotGit ? { pilotGit: extra.pilotGit } : {}),
    ...(extra.pilotGh ? { pilotGh: extra.pilotGh } : {}),
    ...(extra.pushSender ? { pushSender: extra.pushSender } : {}),
    ...(extra.accountsHome ? { accountsHome: extra.accountsHome } : {}),
  });
  return { app, db, worktreesDir, projectsDir };
}

export function cookieHeader(setCookie: string | string[] | undefined, name: string): string {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const found = all.find((c) => c.startsWith(`${name}=`));
  if (!found) throw new Error(`cookie ${name} not set`);
  return found.split(';')[0] ?? '';
}

export const PASSWORD = 'correct horse battery staple';

/** Creates a temp git repo with one commit on `main`. */
export function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'panel-repo-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      stdio: 'pipe',
    });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# test\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

/**
 * A repo with a bare `origin`, a working clone on a feature branch (one commit, not pushed) and a
 * second clone to simulate remote changes (`pushFromOther`).
 */
export function makeRepoWithRemote(branch = 'feature/x'): {
  repo: string;
  remote: string;
  other: string;
  git: (dir: string, ...args: string[]) => string;
  remoteRef: (ref: string) => string;
  pushFromOther: (file: string, content: string, onBranch?: string) => void;
} {
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      encoding: 'utf8',
    });
  const repo = makeGitRepo();
  const remote = join(mkdtempSync(join(tmpdir(), 'panel-remote-')), 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', branch);
  writeFileSync(join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'feat: a');
  const other = mkdtempSync(join(tmpdir(), 'panel-other-'));
  execFileSync('git', ['clone', '-q', remote, other]);
  const remoteRef = (ref: string) =>
    execFileSync('git', ['-C', remote, 'rev-parse', '--verify', '--quiet', ref], {
      encoding: 'utf8',
    }).trim();
  const pushFromOther = (file: string, content: string, onBranch = branch) => {
    git(other, 'fetch', '-q', 'origin');
    const exists = git(other, 'branch', '-r', '--list', 'origin/' + onBranch).trim() !== '';
    if (exists) git(other, 'checkout', '-q', '-B', onBranch, 'origin/' + onBranch);
    else git(other, 'checkout', '-q', '-B', onBranch);
    writeFileSync(join(other, file), content);
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'feat: ' + file);
    git(other, 'push', '-q', 'origin', onBranch);
  };
  return { repo, remote, other, git, remoteRef, pushFromOther };
}

/** A repo that ships `.agents/kyro/`, so the scope and work flows are allowed on it. */
export function makeKyroRepo(): string {
  const repo = makeGitRepo();
  mkdirSync(join(repo, '.agents', 'kyro'), { recursive: true });
  return repo;
}

export function mutatingHeaders(cookie: string, csrfToken: string): Record<string, string> {
  return { cookie, origin: ORIGIN, 'x-csrf-token': csrfToken };
}
