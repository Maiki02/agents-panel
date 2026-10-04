import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
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
import { openDatabase } from '../src/db/index.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { FakeRunner } from './fake-runner.js';
import { PASSWORD, makeApp, makeGitRepo, mutatingHeaders } from './helpers.js';

let apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function boot(runner = new FakeRunner(), db = openDatabase(':memory:')) {
  const made = makeApp({}, undefined, { runner, db });
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
  return { ...made, runner, project, post, get, waitIdle };
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
    const service = new ChatService({ chats, projects, manager: racing, worktreesDir });
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
