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

/** A repo that ships `.agents/kyro/`, so the scope and work flows are allowed on it. */
export function makeKyroRepo(): string {
  const repo = makeGitRepo();
  mkdirSync(join(repo, '.agents', 'kyro'), { recursive: true });
  return repo;
}

export function mutatingHeaders(cookie: string, csrfToken: string): Record<string, string> {
  return { cookie, origin: ORIGIN, 'x-csrf-token': csrfToken };
}
