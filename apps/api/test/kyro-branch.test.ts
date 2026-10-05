import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { SecondFactorRepository, generateTotpCode, generateTotpSecret } from '../src/auth/totp.js';
import { UserRepository } from '../src/auth/users.js';
import { ProjectRepository } from '../src/projects/repo.js';
import type { KyroInitializer } from '../src/projects/service.js';
import { PASSWORD, TEST_ENV, makeApp, makeGitRepo, mutatingHeaders } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
});

const PERIOD_MS = 30_000;

/** Stands in for `kyro install`: writes what it would add to the repo. */
const fakeInstall: KyroInitializer = (cwd) => {
  mkdirSync(join(cwd, '.agents', 'kyro'), { recursive: true });
  writeFileSync(join(cwd, '.agents', 'kyro', 'project.json'), '{"schemaVersion":4}\n');
  return Promise.resolve();
};

async function setup(installer: KyroInitializer = fakeInstall) {
  const state = { t: 1_700_000_000_000 };
  const install = vi.fn<KyroInitializer>(installer);
  const made = makeApp({}, () => state.t, { kyroInstaller: install });
  app = made.app;
  await app.ready();
  const server = app;
  const user = await new UserRepository(made.db).create('alice', PASSWORD);
  const secret = generateTotpSecret();
  new SecondFactorRepository(made.db, Buffer.from(TEST_ENV.PANEL_SECRET_KEY)).setTotpSecret(
    user.id,
    secret,
  );
  const { token, csrfToken } = new SessionService(
    made.db,
    { idleTtlSeconds: 1800, absoluteTtlSeconds: 43200 },
    () => state.t,
  ).create(user.id);
  const headers = mutatingHeaders(`${SESSION_COOKIE}=${token}`, csrfToken);
  const totp = () => {
    state.t += PERIOD_MS;
    return generateTotpCode(secret, state.t);
  };
  const project = await new ProjectRepository(made.db).add({
    name: 'demo',
    repoPath: makeGitRepo(),
    baseBranch: 'main',
  });
  const init = (id: number, payload: Record<string, unknown>) =>
    server.inject({
      method: 'POST',
      url: `/api/projects/${String(id)}/kyro-init`,
      headers,
      payload,
    });
  const git = (repo: string, ...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  return { ...made, install, project, init, totp, git, server, headers };
}

describe('POST /api/projects/:id/kyro-init', () => {
  it('commits the Kyro files on chore/kyro-init in its own worktree and leaves the base clone untouched', async () => {
    const { project, init, totp, git, install, worktreesDir } = await setup();
    const res = await init(project.id, { code: totp() });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ branch: string; path: string; commit: string }>();
    expect(body.branch).toBe('chore/kyro-init');
    expect(body.path).toBe(join(worktreesDir, 'demo', 'kyro-init'));
    expect(install).toHaveBeenCalledWith(body.path);
    expect(git(project.repoPath, 'show', '--name-only', '--format=%s', body.commit)).toBe(
      'chore(kyro): inicializar Kyro\n\n.agents/kyro/project.json',
    );
    expect(git(body.path, 'status', '--porcelain')).toBe('');
    // The base clone neither has Kyro nor changed branch, and nothing was pushed anywhere.
    expect(existsSync(join(project.repoPath, '.agents'))).toBe(false);
    expect(git(project.repoPath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(project.repoPath, 'rev-parse', 'main')).not.toBe(body.commit);
  });

  it('answers 401 without a valid code and touches nothing', async () => {
    const { project, init, install, git, totp } = await setup();
    expect((await init(project.id, {})).statusCode).toBe(401);
    expect((await init(project.id, { code: '000000' })).statusCode).toBe(401);
    expect(install).not.toHaveBeenCalled();
    expect(git(project.repoPath, 'branch', '--list', 'chore/kyro-init')).toBe('');
    expect(totp()).toMatch(/^\d{6}$/);
  });

  it('leaves no worktree or branch when kyro install fails', async () => {
    const { project, init, totp, git, worktreesDir } = await setup(() =>
      Promise.reject(new Error('install exploded')),
    );
    const res = await init(project.id, { code: totp() });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: string }>().error).toContain('install exploded');
    expect(existsSync(join(worktreesDir, 'demo', 'kyro-init'))).toBe(false);
    expect(git(project.repoPath, 'branch', '--list', 'chore/kyro-init')).toBe('');
  });

  it('leaves nothing behind when the install produces no files', async () => {
    const { project, init, totp, git, worktreesDir } = await setup(() => Promise.resolve());
    const res = await init(project.id, { code: totp() });
    expect(res.statusCode).toBe(500);
    expect(existsSync(join(worktreesDir, 'demo', 'kyro-init'))).toBe(false);
    expect(git(project.repoPath, 'branch', '--list', 'chore/kyro-init')).toBe('');
  });

  it('answers 409 when the project already has Kyro, is not ready, or the branch exists', async () => {
    const { project, init, totp, db, install } = await setup();
    mkdirSync(join(project.repoPath, '.agents', 'kyro'), { recursive: true });
    expect((await init(project.id, { code: totp() })).statusCode).toBe(409);
    expect(install).not.toHaveBeenCalled();

    const other = await new ProjectRepository(db).add({
      name: 'other',
      repoPath: makeGitRepo(),
      baseBranch: 'main',
    });
    db.prepare("UPDATE projects SET status = 'cloning' WHERE id = ?").run(other.id);
    expect((await init(other.id, { code: totp() })).statusCode).toBe(409);

    const third = await new ProjectRepository(db).add({
      name: 'third',
      repoPath: makeGitRepo(),
      baseBranch: 'main',
    });
    expect((await init(third.id, { code: totp() })).statusCode).toBe(200);
    const again = await init(third.id, { code: totp() });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: string }>().error).toContain('chore/kyro-init');
  });

  it('answers 404 for an unknown project and 401 without a session', async () => {
    const { init, totp, server } = await setup();
    expect((await init(9999, { code: totp() })).statusCode).toBe(404);
    const anonymous = await server.inject({
      method: 'POST',
      url: '/api/projects/1/kyro-init',
      payload: {},
    });
    expect(anonymous.statusCode).toBeGreaterThanOrEqual(401);
  });

  it('refuses a second init on the same project while one is running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { project, init, totp, install } = await setup(async (cwd) => {
      await gate;
      await fakeInstall(cwd);
    });
    const first = init(project.id, { code: totp() });
    await vi.waitFor(() => {
      expect(install).toHaveBeenCalledTimes(1);
    });
    const second = await init(project.id, { code: totp() });
    expect(second.statusCode).toBe(409);
    expect(install).toHaveBeenCalledTimes(1);
    release();
    expect((await first).statusCode).toBe(200);
  });
});
