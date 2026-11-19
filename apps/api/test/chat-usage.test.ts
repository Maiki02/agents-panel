import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatUsage } from '@agents-panel/shared';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { ChatRepository } from '../src/chats/repo.js';
import { AgentSessionRepository } from '../src/chats/sessions-repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { PASSWORD, makeApp, makeKyroRepo, mutatingHeaders } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot() {
  const made = makeApp();
  app = made.app;
  await made.app.ready();
  const user = await new UserRepository(made.db).create('alice', PASSWORD);
  const { token, csrfToken } = new SessionService(made.db, {
    idleTtlSeconds: 1800,
    absoluteTtlSeconds: 43200,
  }).create(user.id);
  const headers = mutatingHeaders(`${SESSION_COOKIE}=${token}`, csrfToken);
  const project = await new ProjectRepository(made.db).add({
    name: 'demo',
    repoPath: makeKyroRepo(),
    baseBranch: 'main',
  });
  const chat = new ChatRepository(made.db).create({
    projectId: project.id,
    kind: 'work',
    slug: 'u',
    title: 'u',
    worktreePath: '/tmp/wt/u',
    branch: 'feature/u',
    status: 'idle',
  });
  return { ...made, headers, chat, sessions: new AgentSessionRepository(made.db) };
}

describe('GET /api/chats/:id/usage', () => {
  it('returns the usage of each session and the total of the work', async () => {
    const { app: a, headers, chat, sessions } = await boot();
    const first = sessions.open(chat.id, 'executor', 'claude', 'm', 1, {
      step: 'execute',
      policyVersion: 1,
    });
    sessions.setUsage(first, {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      costUsd: 0.5,
    });
    sessions.close(first, 'idle');
    const second = sessions.open(chat.id, 'executor', 'claude', 'm');
    sessions.setUsage(second, {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
      costUsd: 0.25,
    });
    // A session without a result message adds nothing and shows no usage.
    sessions.close(sessions.open(chat.id, 'executor', 'claude', 'm'), 'cancelled');

    const res = await a.inject({ url: `/api/chats/${String(chat.id)}/usage`, headers });
    expect(res.statusCode).toBe(200);
    const body = res.json<ChatUsage>();
    expect(body.sessions.map((s) => [s.step, s.usage?.costUsd ?? null])).toEqual([
      ['execute', 0.5],
      ['manual', 0.25],
      ['manual', null],
    ]);
    expect(body.total).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheCreationTokens: 44,
      costUsd: 0.75,
    });
  });

  it('needs a session and answers 404 for a chat that does not exist', async () => {
    const { app: a, headers, chat } = await boot();
    expect((await a.inject({ url: `/api/chats/${String(chat.id)}/usage` })).statusCode).toBe(401);
    expect((await a.inject({ url: '/api/chats/9999/usage', headers })).statusCode).toBe(404);
  });
});
