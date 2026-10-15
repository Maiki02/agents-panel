import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { CliError, runCli, type CliIo } from '../src/cli/commands.js';
import { GitAccountRepository } from '../src/git-accounts/repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { ProjectService, type Cloner } from '../src/projects/service.js';
import { openDatabase } from '../src/db/index.js';
import { ChatRepository } from '../src/chats/repo.js';
import { ORIGIN, PASSWORD, TEST_ENV, makeApp, makeGitRepo } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
});

const noIo: CliIo & { lines: string[] } = {
  lines: [],
  prompt: () => Promise.resolve(''),
  print(line) {
    this.lines.push(line);
  },
  qr: () => undefined,
};

describe('project:add', () => {
  it('registers a real repo and rejects non-repos and missing branches', async () => {
    const made = makeApp();
    app = made.app;
    const deps = {
      db: made.db,
      secretKey: Buffer.from(TEST_ENV.PANEL_SECRET_KEY),
      sessionTimings: { idleTtlSeconds: 1, absoluteTtlSeconds: 1 },
    };
    const repo = makeGitRepo();
    await runCli(['project:add', 'demo', repo, 'main', 'npm ci'], noIo, deps);
    expect(new ProjectRepository(made.db).list()).toMatchObject([
      { name: 'demo', baseBranch: 'main', setupCommand: 'npm ci' },
    ]);
    await expect(runCli(['project:add', 'bad-branch', repo, 'nope'], noIo, deps)).rejects.toThrow(
      /Base branch not found/,
    );
    const notRepo = mkdtempSync(join(tmpdir(), 'panel-notrepo-'));
    await expect(
      runCli(['project:add', 'bad-repo', notRepo, 'main'], noIo, deps),
    ).rejects.toBeInstanceOf(CliError);
    expect(new ProjectRepository(made.db).list()).toHaveLength(1);
  });

  it('project:list prints status and display name', async () => {
    const made = makeApp();
    app = made.app;
    const deps = {
      db: made.db,
      secretKey: Buffer.from(TEST_ENV.PANEL_SECRET_KEY),
      sessionTimings: { idleTtlSeconds: 1, absoluteTtlSeconds: 1 },
    };
    const io = { ...noIo, lines: [] as string[] };
    await runCli(['project:add', 'demo', makeGitRepo(), 'main'], io, deps);
    made.db.prepare("UPDATE projects SET display_name = 'Mi Demo'").run();
    io.lines.length = 0;
    await runCli(['project:list'], io, deps);
    expect(io.lines).toHaveLength(1);
    const [, name, displayName, status] = (io.lines[0] ?? '').split('\t');
    expect([name, displayName, status]).toEqual(['demo', 'Mi Demo', 'ready']);
  });
});

describe('GET /api/projects', () => {
  it('lists projects with a session and answers 401 without one', async () => {
    const made = makeApp();
    app = made.app;
    await app.ready();
    await new ProjectRepository(made.db).add({
      name: 'demo',
      repoPath: makeGitRepo(),
      baseBranch: 'main',
    });
    expect((await app.inject({ url: '/api/projects' })).statusCode).toBe(401);
    const user = await new UserRepository(made.db).create('alice', PASSWORD);
    const { token } = new SessionService(made.db, {
      idleTtlSeconds: 1800,
      absoluteTtlSeconds: 43200,
    }).create(user.id);
    const res = await app.inject({
      url: '/api/projects',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([{ name: 'demo', baseBranch: 'main' }]);
  });
});

describe('chat events', () => {
  it('numbers events per chat and enforces unique (chat_id, seq)', async () => {
    const made = makeApp();
    app = made.app;
    const project = await new ProjectRepository(made.db).add({
      name: 'demo',
      repoPath: makeGitRepo(),
      baseBranch: 'main',
    });
    const chats = new ChatRepository(made.db);
    const chat = chats.create({
      projectId: project.id,
      kind: 'work',
      slug: 'fix-a',
      title: 'Fix A',
      worktreePath: '/tmp/wt/a',
      branch: 'feature/fix-a',
      status: 'idle',
    });
    expect(chats.appendEvent(chat.id, 'a', {}).seq).toBe(1);
    expect(chats.appendEvent(chat.id, 'b', { x: 1 }).seq).toBe(2);
    expect(chats.eventsAfter(chat.id, 1).map((e) => e.type)).toEqual(['b']);
    expect(() =>
      made.db
        .prepare(
          "INSERT INTO chat_events (chat_id, seq, type, payload, created_at) VALUES (?, 2, 'x', '{}', 0)",
        )
        .run(chat.id),
    ).toThrow(/UNIQUE/);
  });
});

const idOf = (res: { json: () => unknown }): number => (res.json() as { id: number }).id;

describe('project routes (GitHub)', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();

  async function setup() {
    const db = openDatabase(':memory:');
    const bare = join(mkdtempSync(join(tmpdir(), 'panel-bare-')), 'remote.git');
    execFileSync('git', ['clone', '-q', '--bare', makeGitRepo(), bare]);
    const cloner = vi.fn<Cloner>((slug, dest) => {
      execFileSync('git', ['clone', '-q', bare, dest], { stdio: 'pipe' });
      git(dest, 'remote', 'set-url', 'origin', `https://github.com/${slug}.git`);
      return Promise.resolve();
    });
    const projectsDir = mkdtempSync(join(tmpdir(), 'panel-projects-'));
    const projectService = new ProjectService({
      repo: new ProjectRepository(db),
      config: { projectsDir, minFreeDiskGb: 1 },
      cloner,
      freeSpace: () => Promise.resolve(100 * 1024 ** 3),
      kyroInit: () => Promise.resolve(),
    });
    const made = makeApp({ PANEL_PROJECTS_DIR: projectsDir }, undefined, { db, projectService });
    app = made.app;
    await app.ready();
    const user = await new UserRepository(db).create('alice', PASSWORD);
    const { token, csrfToken } = new SessionService(db, {
      idleTtlSeconds: 1800,
      absoluteTtlSeconds: 43200,
    }).create(user.id);
    const headers = {
      cookie: `${SESSION_COOKIE}=${token}`,
      origin: ORIGIN,
      'x-csrf-token': csrfToken,
    };
    return { app: made.app, db, headers, cloner, projectService, projectsDir };
  }

  it('POST answers 202 with the project cloning and it ends ready', async () => {
    const { app, headers, projectService } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { repo: 'https://github.com/o/Mi_Repo.git', displayName: 'Mi Repo' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      name: 'mi-repo',
      displayName: 'Mi Repo',
      status: 'cloning',
    });
    await projectService.whenIdle();
    const detail = await app.inject({ url: `/api/projects/${String(idOf(res))}`, headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      status: 'ready',
      baseBranch: 'main',
      repoUrl: 'https://github.com/o/Mi_Repo',
      hasKyro: false,
      suggestedSetupCommand: null,
    });
    expect((await app.inject({ url: '/api/projects', headers })).json()).toHaveLength(1);
  });

  it('POST answers 201 when an existing folder is adopted and "ya existe" the second time', async () => {
    const { app, headers, cloner, projectsDir } = await setup();
    const dir = join(projectsDir, 'r');
    execFileSync('git', ['clone', '-q', makeGitRepo(), dir], { stdio: 'pipe' });
    git(dir, 'remote', 'set-url', 'origin', 'git@github.com:o/r.git');
    const first = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { repo: 'o/r' },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ status: 'ready' });
    const second = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { repo: 'o/r' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: string }>().error).toMatch(/ya existe/);
    expect(cloner).not.toHaveBeenCalled();
  });

  it('POST answers 409 and leaves the folder alone when its origin is another repo', async () => {
    const { app, headers, cloner, projectsDir } = await setup();
    const dir = join(projectsDir, 'r');
    execFileSync('git', ['clone', '-q', makeGitRepo(), dir], { stdio: 'pipe' });
    git(dir, 'remote', 'set-url', 'origin', 'https://github.com/x/y.git');
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { repo: 'o/r' },
    });
    expect(res.statusCode).toBe(409);
    expect(cloner).not.toHaveBeenCalled();
  });

  it.each([
    { repo: 'file:///etc/passwd' },
    { repo: 'https://evil.com/a/b' },
    { repo: 'a/b/c' },
    { repo: '-x/y' },
    { repo: '' },
    {},
    { repo: 'o/r', name: 'Bad Name' },
    { repo: 'o/r', repoPath: '/home/ubuntu/proyectos/ventas' },
    { repo: 'o/r', path: '/etc' },
    { repo: 'o/r', extra: 1 },
    { repo: 'o/r', displayName: 'x'.repeat(101) },
  ])('POST answers 400 for %j and never runs the cloner', async (payload) => {
    const { app, headers, cloner, db } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/projects', headers, payload });
    expect(res.statusCode).toBe(400);
    expect(cloner).not.toHaveBeenCalled();
    expect(new ProjectRepository(db).list()).toEqual([]);
  });

  it('PATCH changes display name and setup, rejects a missing base branch and unknown fields', async () => {
    const { app, headers, projectService } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { repo: 'o/r' },
    });
    await projectService.whenIdle();
    const url = `/api/projects/${String(idOf(created))}`;
    const ok = await app.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { displayName: 'Producto', setupCommand: 'npm ci' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ displayName: 'Producto', setupCommand: 'npm ci' });
    const bad = await app.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { baseBranch: 'nope' },
    });
    expect(bad.statusCode).toBe(400);
    const extra = await app.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { repoPath: '/etc' },
    });
    expect(extra.statusCode).toBe(400);
    const empty = await app.inject({ method: 'PATCH', url, headers, payload: {} });
    expect(empty.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/projects/999',
      headers,
      payload: { displayName: 'x' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('retry answers 409 unless the project is in error, 404 if unknown, and re-verifies the folder otherwise', async () => {
    const { app, headers, projectService, db } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { repo: 'o/r' },
    });
    await projectService.whenIdle();
    const id = String(idOf(created));
    const notError = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/retry`,
      headers,
    });
    expect(notError.statusCode).toBe(409);
    db.prepare("UPDATE projects SET status = 'error', status_detail = 'x'").run();
    const again = await app.inject({ method: 'POST', url: `/api/projects/${id}/retry`, headers });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: 'ready' });
    expect(
      (await app.inject({ method: 'POST', url: '/api/projects/999/retry', headers })).statusCode,
    ).toBe(404);
  });

  it('suggests bash scripts/panel-setup.sh in the detail only while setup is empty', async () => {
    const { app, headers, projectsDir } = await setup();
    const dir = join(projectsDir, 'r');
    execFileSync('git', ['clone', '-q', makeGitRepo(), dir], { stdio: 'pipe' });
    git(dir, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'panel-setup.sh'), '#!/usr/bin/env bash\n');
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { repo: 'o/r' },
    });
    const url = `/api/projects/${String(idOf(created))}`;
    expect(created.json<{ setupCommand: string | null }>().setupCommand).toBeNull();
    expect((await app.inject({ url, headers })).json()).toMatchObject({
      setupCommand: null,
      suggestedSetupCommand: 'bash scripts/panel-setup.sh',
    });
    await app.inject({ method: 'PATCH', url, headers, payload: { setupCommand: 'npm ci' } });
    expect((await app.inject({ url, headers })).json()).toMatchObject({
      setupCommand: 'npm ci',
      suggestedSetupCommand: null,
    });
  });

  it('turns clones left running into "interrumpido" when the app starts', async () => {
    const db = openDatabase(':memory:');
    const repo = new ProjectRepository(db);
    const stuck = repo.insertGithub({
      name: 'stuck',
      displayName: null,
      repoUrl: 'https://github.com/o/stuck',
      repoPath: '/tmp/never-exists',
      baseBranch: '',
      setupCommand: null,
      status: 'cloning',
      statusDetail: null,
    });
    const made = makeApp({}, undefined, { db });
    app = made.app;
    await app.ready();
    expect(repo.findById(stuck.id)).toMatchObject({
      status: 'error',
      statusDetail: 'interrumpido',
    });
  });

  it('answers 401 without a session on every new route', async () => {
    const { app } = await setup();
    for (const [method, url] of [
      ['POST', '/api/projects'],
      ['GET', '/api/projects/1'],
      ['PATCH', '/api/projects/1'],
      ['POST', '/api/projects/1/retry'],
    ] as const) {
      const res = await app.inject({ method, url, headers: { origin: ORIGIN } });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe('project routes (GitLab and accounts)', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();

  async function setup() {
    const db = openDatabase(':memory:');
    const bare = join(mkdtempSync(join(tmpdir(), 'panel-bare-')), 'remote.git');
    execFileSync('git', ['clone', '-q', '--bare', makeGitRepo(), bare]);
    const sources: unknown[] = [];
    const cloner = vi.fn<Cloner>((slug, dest, source) => {
      sources.push(source);
      execFileSync('git', ['clone', '-q', bare, dest], { stdio: 'pipe' });
      const host = source ? new URL(source.url).hostname : 'github.com';
      git(dest, 'remote', 'set-url', 'origin', `https://${host}/${slug}.git`);
      return Promise.resolve();
    });
    const accounts = new GitAccountRepository(db, Buffer.from(TEST_ENV.PANEL_SECRET_KEY));
    const lab = accounts.create({
      provider: 'gitlab',
      name: 'lab',
      host: 'gitlab.com',
      username: 'u',
      token: 't1',
    });
    const lab2 = accounts.create({
      provider: 'gitlab',
      name: 'lab2',
      host: 'gitlab.com',
      username: 'u2',
      token: 't2',
    });
    const acme = accounts.create({
      provider: 'gitlab',
      name: 'acme',
      host: 'git.acme.io',
      username: 'u3',
      token: 't3',
    });
    const hub = accounts.create({
      provider: 'github',
      name: 'hub',
      host: 'github.com',
      username: 'u4',
      token: 't4',
    });
    const busy = { reason: null as string | null };
    const projectsDir = mkdtempSync(join(tmpdir(), 'panel-projects-'));
    const projectService = new ProjectService({
      repo: new ProjectRepository(db),
      config: { projectsDir, minFreeDiskGb: 1 },
      cloner,
      freeSpace: () => Promise.resolve(100 * 1024 ** 3),
      kyroInit: () => Promise.resolve(),
      accounts,
      credentials: {
        forProject: (id) => {
          const row = db
            .prepare('SELECT git_account_id AS a FROM projects WHERE id = ?')
            .get(id) as { a: number | null } | undefined;
          const account = row?.a ? accounts.findById(row.a) : undefined;
          return account
            ? { host: account.host, username: account.username, token: 'secret' }
            : null;
        },
      },
      isBusy: () => busy.reason,
    });
    const made = makeApp({ PANEL_PROJECTS_DIR: projectsDir }, undefined, { db, projectService });
    app = made.app;
    await app.ready();
    const user = await new UserRepository(db).create('alice', PASSWORD);
    const { token, csrfToken } = new SessionService(db, {
      idleTtlSeconds: 1800,
      absoluteTtlSeconds: 43200,
    }).create(user.id);
    const headers = {
      cookie: `${SESSION_COOKIE}=${token}`,
      origin: ORIGIN,
      'x-csrf-token': csrfToken,
    };
    return { app: made.app, headers, projectService, sources, busy, lab, lab2, acme, hub };
  }

  const post = (ctx: Awaited<ReturnType<typeof setup>>, payload: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: '/api/projects', headers: ctx.headers, payload });

  it('clones a gitlab.com project with its account and ends ready', async () => {
    const ctx = await setup();
    const res = await post(ctx, {
      repo: 'https://gitlab.com/Grupo/sub/Repo.git/-/tree/main',
      gitAccountId: ctx.lab.id,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      name: 'repo',
      status: 'cloning',
      repoUrl: 'https://gitlab.com/Grupo/sub/Repo',
      gitProvider: 'gitlab',
      gitAccountId: ctx.lab.id,
    });
    await ctx.projectService.whenIdle();
    const detail = await ctx.app.inject({
      url: `/api/projects/${String(idOf(res))}`,
      headers: ctx.headers,
    });
    expect(detail.json()).toMatchObject({
      status: 'ready',
      baseBranch: 'main',
      statusDetail: null,
    });
    expect(ctx.sources).toMatchObject([
      {
        url: 'https://gitlab.com/Grupo/sub/Repo.git',
        credential: { host: 'gitlab.com', username: 'u' },
      },
    ]);
  });

  it('accepts a private GitLab whose host has a linked account', async () => {
    const ctx = await setup();
    const res = await post(ctx, {
      repo: 'https://git.acme.io/team/app',
      gitAccountId: ctx.acme.id,
    });
    expect(res.statusCode).toBe(202);
    await ctx.projectService.whenIdle();
    expect(res.json()).toMatchObject({
      repoUrl: 'https://git.acme.io/team/app',
      gitProvider: 'gitlab',
    });
  });

  it.each([
    ['a GitLab host without a linked account', { repo: 'https://git.other.io/team/app' }],
    ['gitlab.com without an account', { repo: 'https://gitlab.com/g/r' }],
    ['credentials in the URL', { repo: 'https://oauth2:tok@gitlab.com/g/r', gitAccountId: 'lab' }],
    ['http', { repo: 'http://gitlab.com/g/r', gitAccountId: 'lab' }],
    ['an account of another host', { repo: 'https://gitlab.com/g/r', gitAccountId: 'acme' }],
    ['a GitHub account on a GitLab URL', { repo: 'https://gitlab.com/g/r', gitAccountId: 'hub' }],
    ['a GitLab account on a GitHub repo', { repo: 'o/r', gitAccountId: 'lab' }],
    ['an unknown account', { repo: 'https://gitlab.com/g/r', gitAccountId: 999 }],
  ] as const)('rejects %s with 400 and creates nothing', async (_label, payload) => {
    const ctx = await setup();
    const ids = { lab: ctx.lab.id, acme: ctx.acme.id, hub: ctx.hub.id } as Record<string, number>;
    const body: Record<string, unknown> = { ...payload };
    const account = body['gitAccountId'];
    if (typeof account === 'string') body['gitAccountId'] = ids[account];
    const res = await post(ctx, body);
    expect(res.statusCode).toBe(400);
    expect((await ctx.app.inject({ url: '/api/projects', headers: ctx.headers })).json()).toEqual(
      [],
    );
  });

  it('keeps GitHub working with no account and with a GitHub one', async () => {
    const ctx = await setup();
    const plain = await post(ctx, { repo: 'o/plain' });
    const withAccount = await post(ctx, { repo: 'o/with', gitAccountId: ctx.hub.id });
    expect(plain.statusCode).toBe(202);
    expect(plain.json()).toMatchObject({ gitProvider: 'github', gitAccountId: null });
    expect(withAccount.json()).toMatchObject({ gitProvider: 'github', gitAccountId: ctx.hub.id });
    await ctx.projectService.whenIdle();
    expect(ctx.sources[0]).toBeUndefined();
    expect(ctx.sources[1]).toMatchObject({ url: 'https://github.com/o/with.git' });
  });

  it('PATCH changes the account within provider and host, and checks both', async () => {
    const ctx = await setup();
    const created = await post(ctx, { repo: 'https://gitlab.com/g/r', gitAccountId: ctx.lab.id });
    await ctx.projectService.whenIdle();
    const url = `/api/projects/${String(idOf(created))}`;
    const patch = (payload: Record<string, unknown>) =>
      ctx.app.inject({ method: 'PATCH', url, headers: ctx.headers, payload });

    const ok = await patch({ gitAccountId: ctx.lab2.id });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ gitAccountId: ctx.lab2.id });
    expect((await patch({ gitAccountId: ctx.acme.id })).statusCode).toBe(400);
    expect((await patch({ gitAccountId: ctx.hub.id })).statusCode).toBe(400);
    expect((await patch({ gitAccountId: null })).statusCode).toBe(400);
    const detail = await ctx.app.inject({ url, headers: ctx.headers });
    expect(detail.json()).toMatchObject({ gitAccountId: ctx.lab2.id });
  });

  it('PATCH answers 409 while the agent or the pilot is active', async () => {
    const ctx = await setup();
    const created = await post(ctx, { repo: 'https://gitlab.com/g/r', gitAccountId: ctx.lab.id });
    await ctx.projectService.whenIdle();
    ctx.busy.reason = 'El agente de un trabajo del proyecto está corriendo';
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/projects/${String(idOf(created))}`,
      headers: ctx.headers,
      payload: { gitAccountId: ctx.lab2.id },
    });
    expect(res.statusCode).toBe(409);
    ctx.busy.reason = null;
    const detail = await ctx.app.inject({
      url: `/api/projects/${String(idOf(created))}`,
      headers: ctx.headers,
    });
    expect(detail.json()).toMatchObject({ gitAccountId: ctx.lab.id });
  });

  it('a GitHub project can go back to the global login with null', async () => {
    const ctx = await setup();
    const created = await post(ctx, { repo: 'o/with', gitAccountId: ctx.hub.id });
    await ctx.projectService.whenIdle();
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/projects/${String(idOf(created))}`,
      headers: ctx.headers,
      payload: { gitAccountId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ gitAccountId: null });
  });
});
