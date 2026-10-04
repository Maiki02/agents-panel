import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentManager } from '../src/agent/manager.js';
import { ChatEventBus } from '../src/chats/events.js';
import { ChatService } from '../src/chats/service.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Chat, ChatEvent } from '@agents-panel/shared';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { buildInitialPrompt } from '../src/chats/service.js';
import { ChatRepository } from '../src/chats/repo.js';
import { openDatabase, type Db } from '../src/db/index.js';
import { EnvFileRepository } from '../src/env-files/repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { FakeRunner } from './fake-runner.js';
import { PASSWORD, TEST_ENV, makeApp, makeGitRepo, mutatingHeaders } from './helpers.js';

let apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function boot(runner = new FakeRunner(), db = openDatabase(':memory:')) {
  const bus = new ChatEventBus();
  const manager = new AgentManager(new ChatRepository(db), runner, bus);
  const made = makeApp({}, undefined, { runner, db, bus, manager });
  apps.push(made.app);
  await made.app.ready();
  const users = new UserRepository(made.db);
  const user = users.findByUsername('alice') ?? (await users.create('alice', PASSWORD));
  const { token, csrfToken } = new SessionService(made.db, {
    idleTtlSeconds: 1800,
    absoluteTtlSeconds: 43200,
  }).create(user.id);
  const headers = mutatingHeaders(`${SESSION_COOKIE}=${token}`, csrfToken);
  const projects = new ProjectRepository(made.db);
  const project =
    projects.list()[0] ??
    (await projects.add({ name: 'demo', repoPath: makeGitRepo(), baseBranch: 'main' }));
  const post = (url: string, payload?: object) =>
    made.app.inject({ method: 'POST', url, headers, ...(payload ? { payload } : {}) });
  const get = (url: string) => made.app.inject({ url, headers });
  const waitIdle = async (id: number) => {
    for (let i = 0; i < 200; i++) {
      if ((await get(`/api/chats/${String(id)}`)).json<Chat>().status !== 'running') return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('chat never became idle');
  };
  return { ...made, runner, manager, project, post, get, waitIdle };
}

describe('chats API', () => {
  it('creates a chat, exposes its events, continues it with resume and lists it', async () => {
    const { runner, project, post, get, waitIdle } = await boot();
    const created = await post('/api/chats', {
      projectId: project.id,
      kind: 'work',
      slug: 'fix-login',
      prompt: 'Fix the login button\nmore detail',
    });
    expect(created.statusCode).toBe(201);
    const chat = created.json<Chat>();
    expect(chat).toMatchObject({
      kind: 'work',
      slug: 'fix-login',
      title: 'Fix the login button',
      branch: 'feature/fix-login',
      projectName: 'demo',
    });
    await waitIdle(chat.id);

    const events = (await get(`/api/chats/${String(chat.id)}/events`)).json<ChatEvent[]>();
    expect(events.map((e) => e.type)).toEqual([
      'worktree_output',
      'user_prompt',
      'system:init',
      'assistant',
      'result:success',
    ]);
    expect(runner.calls[0]?.prompt).toContain('kyro-work/SKILL.md');
    expect(runner.calls[0]?.prompt).toContain('Fix the login button');
    expect(runner.calls[0]?.cwd).toBe(chat.worktreePath);

    const after = (await get(`/api/chats/${String(chat.id)}/events?afterSeq=3`)).json<
      ChatEvent[]
    >();
    expect(after.map((e) => e.seq)).toEqual([4, 5]);

    expect(
      (await post(`/api/chats/${String(chat.id)}/messages`, { text: 'continue' })).statusCode,
    ).toBe(202);
    await waitIdle(chat.id);
    expect(runner.calls[1]).toMatchObject({ prompt: 'continue', resumeSessionId: 'sess-1' });

    const list = (await get('/api/chats')).json<Chat[]>();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'idle', sdkSessionId: 'sess-1' });
  });

  it('returns 409 when messaging a chat that is already running, and can cancel it', async () => {
    const runner = new FakeRunner();
    let release: () => void = () => undefined;
    runner.gate = new Promise((resolve) => {
      release = resolve;
    });
    const { project, post, get, waitIdle } = await boot(runner);
    const chat = (
      await post('/api/chats', { projectId: project.id, kind: 'scope', slug: 'big', prompt: 'x' })
    ).json<Chat>();
    expect((await get(`/api/chats/${String(chat.id)}`)).json<Chat>().status).toBe('running');
    expect((await post(`/api/chats/${String(chat.id)}/messages`, { text: 'hi' })).statusCode).toBe(
      409,
    );
    expect((await post(`/api/chats/${String(chat.id)}/cancel`)).statusCode).toBe(200);
    release();
    await waitIdle(chat.id);
    expect((await get(`/api/chats/${String(chat.id)}`)).json<Chat>().status).toBe('cancelled');
    expect((await post(`/api/chats/${String(chat.id)}/cancel`)).statusCode).toBe(409);
  });

  it('validates input and reports conflicts', async () => {
    const { project, post, waitIdle } = await boot();
    expect(
      (await post('/api/chats', { projectId: project.id, kind: 'nope', slug: 'a', prompt: 'x' }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await post('/api/chats', {
          projectId: project.id,
          kind: 'work',
          slug: 'Bad Slug',
          prompt: 'x',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await post('/api/chats', { projectId: 999, kind: 'work', slug: 'a', prompt: 'x' }))
        .statusCode,
    ).toBe(404);
    const ok = await post('/api/chats', {
      projectId: project.id,
      kind: 'work',
      slug: 'dup',
      prompt: 'x',
    });
    await waitIdle(ok.json<Chat>().id);
    expect(
      (await post('/api/chats', { projectId: project.id, kind: 'work', slug: 'dup', prompt: 'x' }))
        .statusCode,
    ).toBe(409);
  });

  it('refuses unknown fields with 400 instead of dropping them, creating nothing', async () => {
    const { project, post, get, worktreesDir, waitIdle } = await boot();
    const res = await post('/api/chats', {
      projectId: project.id,
      kind: 'work',
      slug: 'extra',
      prompt: 'x',
      worktreePath: '/tmp/elsewhere',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Unknown field: worktreePath' });
    expect((await get('/api/chats')).json()).toEqual([]);
    expect(existsSync(join(worktreesDir, 'demo', 'extra'))).toBe(false);

    const ok = await post('/api/chats', {
      projectId: project.id,
      kind: 'work',
      slug: 'ok',
      prompt: 'x',
    });
    const chat = ok.json<Chat>();
    await waitIdle(chat.id);
    const message = await post(`/api/chats/${String(chat.id)}/messages`, {
      text: 'hi',
      model: 'x',
    });
    expect(message.statusCode).toBe(400);
    expect(message.json()).toEqual({ error: 'Unknown field: model' });
  });

  it('answers 401 on every chat route without a session', async () => {
    const { app } = await boot();
    for (const [method, url] of [
      ['GET', '/api/chats'],
      ['GET', '/api/chats/1'],
      ['GET', '/api/chats/1/events'],
      ['POST', '/api/chats'],
    ] as const) {
      const res = await app.inject({ method, url, headers: { origin: 'http://localhost:4200' } });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('marks chats left running as interrupted on startup and lets them continue', async () => {
    const db = openDatabase(':memory:');
    const first = await boot(new FakeRunner(), db);
    const chats = new ChatRepository(db);
    const chat = chats.create({
      projectId: first.project.id,
      kind: 'work',
      slug: 'crashed',
      title: 'crashed',
      worktreePath: '/tmp/wt/crashed',
      branch: 'feature/crashed',
      status: 'running',
    });
    chats.setSessionId(chat.id, 'sess-old');

    const second = await boot(new FakeRunner(), db);
    expect((await second.get(`/api/chats/${String(chat.id)}`)).json<Chat>().status).toBe(
      'interrupted',
    );
    expect(
      (await second.post(`/api/chats/${String(chat.id)}/messages`, { text: 'resume' })).statusCode,
    ).toBe(202);
    await second.waitIdle(chat.id);
    expect(second.runner.calls[0]).toMatchObject({ resumeSessionId: 'sess-old', prompt: 'resume' });
  });
});

describe('create on a project that is not ready', () => {
  it.each(['cloning', 'error'] as const)(
    'answers 409 for a %s project and creates no worktree, chat or event',
    async (status) => {
      const { runner, project, post, get, db, worktreesDir } = await boot();
      db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(status, project.id);
      const res = await post('/api/chats', {
        projectId: project.id,
        kind: 'work',
        slug: 'fix-a',
        prompt: 'hola',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toContain(status);
      expect((await get('/api/chats')).json<Chat[]>()).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM chat_events').get()).toEqual({ n: 0 });
      expect(existsSync(join(worktreesDir, project.name))).toBe(false);
      expect(runner.calls).toHaveLength(0);
    },
  );

  it('keeps working on a ready project (a migrated one included)', async () => {
    const { project, post, get, waitIdle } = await boot();
    expect(project.status).toBe('ready');
    const res = await post('/api/chats', {
      projectId: project.id,
      kind: 'work',
      slug: 'ok',
      prompt: 'hola',
    });
    expect(res.statusCode).toBe(201);
    await waitIdle(res.json<Chat>().id);
    expect((await get('/api/chats')).json<Chat[]>()).toHaveLength(1);
  });
});

describe('create at the session limit', () => {
  it('answers 409 and leaves no chat, worktree or branch; the slug works once there is room', async () => {
    const runner = new FakeRunner();
    let release: () => void = () => undefined;
    runner.gate = new Promise((resolve) => {
      release = resolve;
    });
    const { project, post, get, waitIdle, worktreesDir } = await boot(runner);
    const running: number[] = [];
    for (const slug of ['s1', 's2', 's3', 's4']) {
      const res = await post('/api/chats', {
        projectId: project.id,
        kind: 'work',
        slug,
        prompt: 'x',
      });
      expect(res.statusCode).toBe(201);
      running.push(res.json<Chat>().id);
    }
    const rejected = await post('/api/chats', {
      projectId: project.id,
      kind: 'work',
      slug: 'fifth',
      prompt: 'x',
    });
    expect(rejected.statusCode).toBe(409);
    expect((await get('/api/chats')).json<Chat[]>()).toHaveLength(4);
    expect(existsSync(join(worktreesDir, 'demo', 'fifth'))).toBe(false);
    expect(
      execFileSync('git', ['-C', project.repoPath, 'branch', '--list', 'feature/fifth'], {
        encoding: 'utf8',
      }),
    ).toBe('');

    release();
    for (const id of running) await waitIdle(id);
    const retry = await post('/api/chats', {
      projectId: project.id,
      kind: 'work',
      slug: 'fifth',
      prompt: 'x',
    });
    expect(retry.statusCode).toBe(201);
  });
});

describe('maintenance lock', () => {
  const body = (project: { id: number }, slug: string) => ({
    projectId: project.id,
    kind: 'work' as const,
    slug,
    prompt: 'x',
  });

  it('is refused with a running session and does not activate', async () => {
    const runner = new FakeRunner();
    let release: () => void = () => undefined;
    runner.gate = new Promise((resolve) => {
      release = resolve;
    });
    const { manager, project, post, waitIdle } = await boot(runner);
    const created = await post('/api/chats', body(project, 'busy'));
    expect(manager.tryBeginMaintenance()).toEqual({ ok: false, running: 1 });
    expect(manager.inMaintenance).toBe(false);
    release();
    await waitIdle(created.json<Chat>().id);
    expect(manager.tryBeginMaintenance()).toEqual({ ok: true });
    expect(manager.tryBeginMaintenance()).toEqual({ ok: false, reason: 'maintenance' });
  });

  it('answers 409 to create and to messages, leaving nothing behind; works again after endMaintenance', async () => {
    const { manager, project, post, get, waitIdle, worktreesDir } = await boot();
    const first = await post('/api/chats', body(project, 'before'));
    expect(first.statusCode).toBe(201);
    const chatId = first.json<Chat>().id;
    await waitIdle(chatId);
    const eventsBefore = (await get(`/api/chats/${String(chatId)}`)).json<Chat>();

    expect(manager.tryBeginMaintenance()).toEqual({ ok: true });
    const blocked = await post('/api/chats', body(project, 'during'));
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ error: string }>().error).toContain('Kyro se está actualizando');
    expect((await get('/api/chats')).json<Chat[]>()).toHaveLength(1);
    expect(existsSync(join(worktreesDir, 'demo', 'during'))).toBe(false);
    expect(
      execFileSync('git', ['-C', project.repoPath, 'branch', '--list', 'feature/during'], {
        encoding: 'utf8',
      }),
    ).toBe('');
    const message = await post(`/api/chats/${String(chatId)}/messages`, { text: 'hola' });
    expect(message.statusCode).toBe(409);
    expect((await get(`/api/chats/${String(chatId)}`)).json<Chat>().status).toBe(
      eventsBefore.status,
    );

    manager.endMaintenance();
    const again = await post('/api/chats', body(project, 'during'));
    expect(again.statusCode).toBe(201);
    await waitIdle(again.json<Chat>().id);
    const resumed = await post(`/api/chats/${String(chatId)}/messages`, { text: 'hola' });
    expect(resumed.statusCode).toBeLessThan(300);
  });
});

describe('create rollback', () => {
  it('removes chat, worktree and branch when the session cannot start after they were created', async () => {
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const project = await projects.add({
      name: 'demo',
      repoPath: makeGitRepo(),
      baseBranch: 'main',
    });
    const chats = new ChatRepository(db);
    const worktreesDir = mkdtempSync(join(tmpdir(), 'panel-rb-'));
    // Capacity looks free at the check, then is gone by the time the turn starts (a real race).
    const racing = new AgentManager(chats, new FakeRunner(), new ChatEventBus(), 0);
    racing.hasCapacity = () => true;
    const service = new ChatService({
      chats,
      projects,
      manager: racing,
      worktreesDir,
      envFiles: new EnvFileRepository(db, SECRET),
    });
    await expect(
      service.create({ projectId: project.id, kind: 'work', slug: 'racy', prompt: 'x' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(chats.list()).toHaveLength(0);
    expect(existsSync(join(worktreesDir, 'demo', 'racy'))).toBe(false);
    expect(
      execFileSync('git', ['-C', project.repoPath, 'branch', '--list', 'feature/racy'], {
        encoding: 'utf8',
      }),
    ).toBe('');
  });
});

const SECRET = Buffer.from(TEST_ENV.PANEL_SECRET_KEY);
const ENV_SENTINEL = 'S3NT1NEL_CHAT_ENV_93fa';

describe('create with .env files', () => {
  /** A project whose committed .gitignore ignores the .env files, with the given setup. */
  async function envSetup(setupCommand?: string) {
    const db: Db = openDatabase(':memory:');
    const repoPath = makeGitRepo();
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repoPath, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
    writeFileSync(join(repoPath, '.gitignore'), '/.env*\nbackend/.env\n');
    git('add', '.gitignore');
    git('commit', '-q', '-m', 'ignore env');
    const projects = new ProjectRepository(db);
    const project = await projects.add({
      name: 'demo',
      repoPath,
      baseBranch: 'main',
      setupCommand,
    });
    const chats = new ChatRepository(db);
    const worktreesDir = mkdtempSync(join(tmpdir(), 'panel-env-wt-'));
    const envFiles = new EnvFileRepository(db, SECRET);
    const manager = new AgentManager(chats, new FakeRunner(), new ChatEventBus());
    const service = new ChatService({ chats, projects, manager, worktreesDir, envFiles });
    const create = (slug: string) =>
      service.create({ projectId: project.id, kind: 'work', slug, prompt: 'x' });
    const branches = (slug: string) =>
      execFileSync('git', ['-C', repoPath, 'branch', '--list', `feature/${slug}`], {
        encoding: 'utf8',
      });
    return { db, project, chats, worktreesDir, envFiles, create, branches };
  }

  it('writes backend/.env (600) after a setup that creates the folder; events carry paths only', async () => {
    const { db, project, chats, envFiles, create } = await envSetup('mkdir backend');
    envFiles.upsert(project.id, '.env', `A=${ENV_SENTINEL}\n`, ['A']);
    envFiles.upsert(project.id, 'backend/.env', `B=${ENV_SENTINEL}\n`, ['B']);

    const chat = await create('with-env');
    const envPath = join(chat.worktreePath, 'backend', '.env');
    expect(lstatSync(envPath).mode & 0o777).toBe(0o600);
    expect(
      execFileSync('git', ['-C', chat.worktreePath, 'status', '--porcelain'], { encoding: 'utf8' }),
    ).toBe('');

    const envEvent = chats
      .eventsAfter(chat.id)
      .find((e) => (e.payload as { step?: string }).step === 'env');
    expect(envEvent).toMatchObject({
      type: 'worktree_output',
      payload: { step: 'env', paths: ['.env', 'backend/.env'] },
    });
    expect(JSON.stringify(db.prepare('SELECT * FROM chat_events').all())).not.toContain(
      ENV_SENTINEL,
    );
  });

  it('answers 422 when setup does not create the folder and rolls everything back', async () => {
    const { project, chats, worktreesDir, envFiles, create, branches } = await envSetup();
    envFiles.upsert(project.id, 'backend/.env', 'B=1\n', ['B']);

    await expect(create('no-backend')).rejects.toMatchObject({
      status: 422,
      message: 'falta la carpeta backend para backend/.env',
    });
    expect(chats.list()).toHaveLength(0);
    expect(existsSync(join(worktreesDir, 'demo', 'no-backend'))).toBe(false);
    expect(branches('no-backend')).toBe('');
  });

  it('answers 422 when a .env is unreadable and rolls everything back', async () => {
    const { db, project, chats, worktreesDir, create, branches } = await envSetup('mkdir backend');
    new EnvFileRepository(db, Buffer.from('another-secret-key-another-secret-key-1')).upsert(
      project.id,
      '.env',
      'A=1\n',
      ['A'],
    );

    await expect(create('unreadable')).rejects.toMatchObject({
      status: 422,
      message: 'el .env .env está ilegible, volvé a subirlo',
    });
    expect(chats.list()).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM chat_events').get()).toEqual({ n: 0 });
    expect(existsSync(join(worktreesDir, 'demo', 'unreadable'))).toBe(false);
    expect(branches('unreadable')).toBe('');
  });
});

describe('buildInitialPrompt', () => {
  it('points the agent at the installed Kyro skill for the chosen flow', () => {
    expect(buildInitialPrompt('scope', 'Do X', '/home/u')).toContain(
      '/home/u/.agents/skills/kyro-forge/SKILL.md',
    );
    expect(buildInitialPrompt('work', 'Do X', '/home/u')).toContain(
      '/home/u/.agents/skills/kyro-work/SKILL.md',
    );
  });
});
