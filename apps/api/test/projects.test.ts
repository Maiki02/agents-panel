import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { CliError, runCli, type CliIo } from '../src/cli/commands.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { ChatRepository } from '../src/chats/repo.js';
import { PASSWORD, TEST_ENV, makeApp, makeGitRepo } from './helpers.js';

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
