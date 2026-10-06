import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KyroInitPushResult, Project } from '@agents-panel/shared';
import type { AppDeps } from '../src/app.js';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { ProjectRepository, pendingKyroInit } from '../src/projects/repo.js';
import { PASSWORD, makeApp, makeGitRepo, mutatingHeaders } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
});

const REPO_URL = 'https://github.com/owner/demo';
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8',
  }).trim();

async function setup(failWith?: Error) {
  const gitPush = vi.fn<(cwd: string, branch: string) => Promise<void>>(() =>
    failWith ? Promise.reject(failWith) : Promise.resolve(),
  );
  const pilotGit = { push: gitPush } as unknown as NonNullable<AppDeps['pilotGit']>;
  const made = makeApp({}, undefined, { pilotGit });
  app = made.app;
  await made.app.ready();
  const user = await new UserRepository(made.db).create('alice', PASSWORD);
  const { token, csrfToken } = new SessionService(made.db, {
    idleTtlSeconds: 1800,
    absoluteTtlSeconds: 43200,
  }).create(user.id);
  const headers = mutatingHeaders(`${SESSION_COOKIE}=${token}`, csrfToken);
  const repoPath = makeGitRepo();
  const project = await new ProjectRepository(made.db).add({
    name: 'demo',
    repoPath,
    baseBranch: 'main',
  });
  made.db.prepare('UPDATE projects SET repo_url = ? WHERE id = ?').run(REPO_URL, project.id);
  const list = async () =>
    (await made.app.inject({ url: '/api/projects', headers })).json<Project[]>();
  const pushBranch = (id: number) =>
    made.app.inject({ method: 'POST', url: `/api/projects/${String(id)}/kyro-init/push`, headers });
  return { app: made.app, project, repoPath, list, pushBranch, gitPush };
}

describe('kyroInit of a project', () => {
  it('is null without the branch, and shows it pending (not pushed) once it exists', async () => {
    const { list, repoPath } = await setup();
    expect((await list())[0]?.kyroInit).toBeNull();
    git(repoPath, 'branch', 'chore/kyro-init');
    expect((await list())[0]?.kyroInit).toEqual({
      branch: 'chore/kyro-init',
      pushed: false,
      prUrl: `${REPO_URL}/pull/new/chore/kyro-init`,
    });
  });

  it('knows when the branch is already on origin', async () => {
    const { repoPath } = await setup();
    git(repoPath, 'branch', 'chore/kyro-init');
    git(repoPath, 'update-ref', 'refs/remotes/origin/chore/kyro-init', 'HEAD');
    expect(pendingKyroInit(repoPath, null)).toEqual({
      branch: 'chore/kyro-init',
      pushed: true,
      prUrl: null,
    });
  });

  it('disappears once the clone has Kyro (after the merge and the pull)', async () => {
    const { list, repoPath } = await setup();
    git(repoPath, 'branch', 'chore/kyro-init');
    mkdirSync(join(repoPath, '.agents', 'kyro'), { recursive: true });
    expect((await list())[0]).toMatchObject({ hasKyro: true, kyroInit: null });
    rmSync(join(repoPath, '.agents'), { recursive: true });
  });
});

describe('reading the init branch without git', () => {
  it('answers from the ref files (loose and packed) with no git on the PATH, and sees changes at once', async () => {
    const { repoPath } = await setup();
    git(repoPath, 'branch', 'chore/kyro-init');
    vi.stubEnv('PATH', '/nonexistent');
    try {
      // Any git call would fail with ENOENT and read as "no branch".
      expect(pendingKyroInit(repoPath, null)).toMatchObject({ pushed: false });
      vi.unstubAllEnvs();
      git(repoPath, 'update-ref', 'refs/remotes/origin/chore/kyro-init', 'HEAD');
      vi.stubEnv('PATH', '/nonexistent');
      expect(pendingKyroInit(repoPath, null)).toMatchObject({ pushed: true });
      vi.unstubAllEnvs();
      git(repoPath, 'pack-refs', '--all', '--prune');
      vi.stubEnv('PATH', '/nonexistent');
      expect(pendingKyroInit(repoPath, null)).toMatchObject({ pushed: true });
      vi.unstubAllEnvs();
      git(repoPath, 'branch', '-D', 'chore/kyro-init');
      vi.stubEnv('PATH', '/nonexistent');
      expect(pendingKyroInit(repoPath, null)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('POST /api/projects/:id/kyro-init/push', () => {
  it('pushes only the pending branch of the project and answers the PR link', async () => {
    const { pushBranch, project, repoPath, gitPush } = await setup();
    git(repoPath, 'branch', 'chore/kyro-init');
    const res = await pushBranch(project.id);
    expect(res.statusCode).toBe(200);
    expect(res.json<KyroInitPushResult>()).toEqual({
      branch: 'chore/kyro-init',
      prUrl: `${REPO_URL}/pull/new/chore/kyro-init`,
    });
    expect(gitPush).toHaveBeenCalledWith(repoPath, 'chore/kyro-init');
  });

  it('answers 409 without a pending branch or when the clone already has Kyro, and pushes nothing', async () => {
    const { pushBranch, project, repoPath, gitPush } = await setup();
    expect((await pushBranch(project.id)).statusCode).toBe(409);
    git(repoPath, 'branch', 'chore/kyro-init');
    mkdirSync(join(repoPath, '.agents', 'kyro'), { recursive: true });
    writeFileSync(join(repoPath, '.agents', 'kyro', 'project.json'), '{}');
    expect((await pushBranch(project.id)).statusCode).toBe(409);
    expect(gitPush).not.toHaveBeenCalled();
  });

  it('shows the error when the push fails', async () => {
    const { pushBranch, project, repoPath } = await setup(new Error('rejected'));
    git(repoPath, 'branch', 'chore/kyro-init');
    const res = await pushBranch(project.id);
    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: string }>().error).toContain('rejected');
  });

  it('answers 404 for an unknown project and 401 without a session', async () => {
    const { pushBranch, app: server } = await setup();
    expect((await pushBranch(9999)).statusCode).toBe(404);
    const res = await server.inject({
      method: 'POST',
      url: '/api/projects/1/kyro-init/push',
      headers: { origin: 'http://localhost:4200' },
    });
    expect(res.statusCode).toBe(401);
  });
});
