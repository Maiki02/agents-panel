import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { ChatEventBus } from '../src/chats/events.js';
import { ChatRepository } from '../src/chats/repo.js';
import { AutopilotRunRepository } from '../src/pilot/runs-repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { WorktreeStateRepository } from '../src/worktrees/state-repo.js';
import { PASSWORD, makeApp, makeKyroRepo } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const PR = 'https://github.com/acme/demo/pull/7';

async function boot(answer: (cwd: string, head: string) => Promise<string[]>) {
  const calls: { cwd: string; head: string }[] = [];
  const made = makeApp({}, undefined, {
    branchPrs: (cwd, head) => {
      calls.push({ cwd, head });
      return answer(cwd, head);
    },
  });
  app = made.app;
  await made.app.ready();
  const user = await new UserRepository(made.db).create('alice', PASSWORD);
  const { token } = new SessionService(made.db, {
    idleTtlSeconds: 1800,
    absoluteTtlSeconds: 43200,
  }).create(user.id);
  const cookie = `${SESSION_COOKIE}=${token}`;
  const repoPath = makeKyroRepo();
  const project = await new ProjectRepository(made.db).add({
    name: 'demo',
    repoPath,
    baseBranch: 'main',
  });
  const chats = new ChatRepository(made.db);
  const runs = new AutopilotRunRepository(made.db);
  const states = new WorktreeStateRepository(made.db, chats, new ChatEventBus());
  const newChat = (slug: string, worktreePath = mkdtempSync(join(tmpdir(), 'panel-wt-'))) =>
    chats.create({
      projectId: project.id,
      kind: 'work',
      slug,
      title: slug,
      worktreePath,
      branch: `feature/${slug}`,
      status: 'idle',
    });
  const pr = async (id: number, headers: Record<string, string> = { cookie }) =>
    made.app.inject({ url: `/api/chats/${String(id)}/pr`, headers });
  return { calls, chats, runs, states, newChat, pr, repoPath };
}

describe('GET /api/chats/:id/pr', () => {
  it('returns the PRs the pilot kept without asking GitHub', async () => {
    const { calls, runs, states, newChat, pr } = await boot(() => Promise.resolve([]));
    const chat = newChat('a');
    states.transition(chat.id, { state: 'pr_lista', actor: 'pilot' });
    runs.create(chat.id);
    runs.setPrUrls(chat.id, [PR]);
    const res = await pr(chat.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ urls: [PR] });
    expect(calls).toEqual([]);
  });

  it('looks up the branch of a finished work in GitHub and keeps what it finds', async () => {
    const { calls, runs, states, newChat, pr } = await boot(() => Promise.resolve([PR]));
    const chat = newChat('b');
    states.transition(chat.id, { state: 'terminado', actor: 'agent' });
    runs.create(chat.id);
    expect((await pr(chat.id)).json()).toEqual({ urls: [PR] });
    expect(calls).toEqual([{ cwd: chat.worktreePath, head: 'feature/b' }]);
    expect(runs.get(chat.id)?.prUrls).toEqual([PR]);
    // Kept: the second visit does not ask again.
    await pr(chat.id);
    expect(calls).toHaveLength(1);
  });

  it('asks in the project clone when the worktree is gone, and works without a pilot run', async () => {
    const { calls, states, newChat, pr, repoPath } = await boot(() => Promise.resolve([PR]));
    const chat = newChat('c', '/nonexistent/panel-wt/c');
    states.transition(chat.id, { state: 'terminado', actor: 'agent' });
    expect((await pr(chat.id)).json()).toEqual({ urls: [PR] });
    expect(calls).toEqual([{ cwd: repoPath, head: 'feature/c' }]);
  });

  it('does not ask GitHub while the work is still running', async () => {
    const { calls, states, newChat, pr } = await boot(() => Promise.resolve([PR]));
    const chat = newChat('d');
    states.transition(chat.id, { state: 'revisando_tarea', actor: 'agent' });
    expect((await pr(chat.id)).json()).toEqual({ urls: [] });
    expect(calls).toEqual([]);
  });

  it('answers an empty list when gh fails', async () => {
    const { states, newChat, pr } = await boot(() => Promise.reject(new Error('gh: no auth')));
    const chat = newChat('e');
    states.transition(chat.id, { state: 'terminado', actor: 'agent' });
    const res = await pr(chat.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ urls: [] });
  });

  it('needs a session', async () => {
    const { newChat, pr } = await boot(() => Promise.resolve([PR]));
    const chat = newChat('f');
    expect((await pr(chat.id, {})).statusCode).toBe(401);
  });
});
