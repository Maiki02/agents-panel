import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { WorktreeStateId } from '@agents-panel/shared';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { ChatEventBus } from '../src/chats/events.js';
import { ChatRepository } from '../src/chats/repo.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { prStateOf, type PrState } from '../src/pilot/github-cli.js';
import { PrWatcher } from '../src/pilot/pr-watcher.js';
import { AutopilotRunRepository } from '../src/pilot/runs-repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { WorktreeStateRepository } from '../src/worktrees/state-repo.js';
import { PASSWORD, TEST_ENV, makeApp, makeKyroRepo } from './helpers.js';

const ROOT = 'https://github.com/acme/demo/pull/7';
const CHILD = 'https://github.com/acme/demo-fe/pull/3';

async function setup(answers: Record<string, PrState | Error>, urls: string[] = [ROOT]) {
  const db = openDatabase(':memory:');
  const chats = new ChatRepository(db);
  const states = new WorktreeStateRepository(db, chats, new ChatEventBus());
  const projects = new ProjectRepository(db);
  const project = await projects.add({
    name: 'demo',
    repoPath: makeKyroRepo(),
    baseBranch: 'main',
  });
  const asked: string[] = [];
  const logs: string[] = [];
  const watcher = new PrWatcher({
    chats,
    states,
    projects,
    prs: { urls: () => Promise.resolve(urls) },
    prState: (_cwd, url) => {
      asked.push(url);
      const answer = answers[url];
      if (answer === undefined) return Promise.reject(new Error(`unexpected ${url}`));
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    log: (message) => logs.push(message),
  });
  const newChat = (
    slug: string,
    state: WorktreeStateId,
    status: 'idle' | 'running' = 'idle',
    kind: 'work' | 'scope' | 'direct' = 'work',
  ) => {
    const chat = chats.create({
      projectId: project.id,
      kind,
      slug,
      title: slug,
      worktreePath: mkdtempSync(join(tmpdir(), 'panel-wt-')),
      branch: `feature/${slug}`,
      status,
    });
    states.transition(chat.id, {
      state,
      actor: 'pilot',
      phase: 'cierre',
      taskDone: 4,
      taskTotal: 4,
      model: 'claude-sonnet-5-5',
    });
    return chat;
  };
  return { watcher, states, newChat, asked, logs };
}

describe('PrWatcher', () => {
  it('moves a work in pr_lista to mergeada when every PR is merged, keeping its progress', async () => {
    const { watcher, states, newChat } = await setup({ [ROOT]: 'MERGED', [CHILD]: 'MERGED' }, [
      ROOT,
      CHILD,
    ]);
    const chat = newChat('a', 'pr_lista');
    expect(await watcher.check(chat)).toBe('merged');
    const state = states.get(chat.id);
    expect(state).toMatchObject({
      state: 'mergeada',
      actor: 'pilot',
      phase: 'cierre',
      taskDone: 4,
      taskTotal: 4,
      model: 'claude-sonnet-5-5',
      detail: `${ROOT}, ${CHILD}`,
      previousState: 'pr_lista',
    });
    const entry = states.timeline(chat.id).at(-1);
    expect(entry).toMatchObject({ toState: 'mergeada', actor: 'pilot' });
    expect(entry?.data).toEqual({ prUrls: [ROOT, CHILD] });
  });

  it('also follows a terminado work whose PR was opened outside the merge phase', async () => {
    const { watcher, states, newChat } = await setup({ [ROOT]: 'MERGED' });
    const chat = newChat('b', 'terminado');
    expect(await watcher.check(chat)).toBe('merged');
    expect(states.get(chat.id)?.state).toBe('mergeada');
  });

  it('changes nothing while one PR is still open', async () => {
    const { watcher, states, newChat } = await setup({ [ROOT]: 'MERGED', [CHILD]: 'OPEN' }, [
      ROOT,
      CHILD,
    ]);
    const chat = newChat('c', 'pr_lista');
    expect(await watcher.check(chat)).toBe('open');
    expect(states.get(chat.id)?.state).toBe('pr_lista');
  });

  it('sends the work to revisar when a PR was closed without merging', async () => {
    const { watcher, states, newChat } = await setup({ [ROOT]: 'MERGED', [CHILD]: 'CLOSED' }, [
      ROOT,
      CHILD,
    ]);
    const chat = newChat('d', 'pr_lista');
    expect(await watcher.check(chat)).toBe('closed');
    expect(states.get(chat.id)).toMatchObject({ state: 'revisar', actor: 'pilot', detail: CHILD });
    expect(states.timeline(chat.id).at(-1)?.data).toEqual({
      prUrls: [ROOT, CHILD],
      closed: [CHILD],
    });
  });

  it('changes nothing and logs when gh fails', async () => {
    const { watcher, states, newChat, logs } = await setup({ [ROOT]: new Error('gh: no auth') });
    const chat = newChat('e', 'pr_lista');
    expect(await watcher.check(chat)).toBe('failed');
    expect(states.get(chat.id)?.state).toBe('pr_lista');
    expect(logs[0]).toContain('gh: no auth');
  });

  it('changes nothing for a work without PRs', async () => {
    const { watcher, states, newChat, asked } = await setup({}, []);
    const chat = newChat('f', 'terminado');
    expect(await watcher.check(chat)).toBe('none');
    expect(states.get(chat.id)?.state).toBe('terminado');
    expect(asked).toEqual([]);
  });

  it('skips a running chat, other states and direct chats', async () => {
    const { watcher, states, newChat, asked } = await setup({ [ROOT]: 'MERGED' });
    const running = newChat('g', 'pr_lista', 'running');
    const moving = newChat('h', 'escribiendo_codigo');
    const direct = newChat('i', 'pr_lista', 'idle', 'direct');
    for (const chat of [running, moving, direct]) {
      expect(await watcher.check(chat)).toBe('skipped');
    }
    expect(states.get(running.id)?.state).toBe('pr_lista');
    expect(states.get(moving.id)?.state).toBe('escribiendo_codigo');
    expect(asked).toEqual([]);
  });

  it('checkAll walks only the watched works', async () => {
    const { watcher, states, newChat } = await setup({ [ROOT]: 'MERGED' });
    const ready = newChat('j', 'pr_lista');
    const done = newChat('k', 'terminado');
    const moving = newChat('l', 'qa');
    await watcher.checkAll();
    expect(states.get(ready.id)?.state).toBe('mergeada');
    expect(states.get(done.id)?.state).toBe('mergeada');
    expect(states.get(moving.id)?.state).toBe('qa');
  });

  it('checkAll logs a work that throws and goes on with the next one', async () => {
    const { watcher, states, newChat, logs } = await setup({ [ROOT]: 'MERGED' });
    const broken = newChat('n', 'pr_lista');
    const ready = newChat('o', 'pr_lista');
    const original = states.transition.bind(states);
    states.transition = (chatId, input) => {
      if (chatId === broken.id) throw new Error('database is locked');
      return original(chatId, input);
    };
    await expect(watcher.checkAll()).resolves.toBeUndefined();
    expect(logs[0]).toContain('database is locked');
    expect(states.get(ready.id)?.state).toBe('mergeada');
  });

  it('prStateOf only takes the URL of a GitHub PR', async () => {
    await expect(prStateOf(tmpdir(), '--repo=evil')).rejects.toThrow('No es la URL');
    await expect(prStateOf(tmpdir(), 'https://example.com/a/b/pull/1')).rejects.toThrow(
      'No es la URL',
    );
  });

  it('does not overlap two checks of the same work', async () => {
    const { watcher, newChat } = await setup({ [ROOT]: 'MERGED' });
    const chat = newChat('m', 'pr_lista');
    const [first, second] = await Promise.all([watcher.check(chat), watcher.check(chat)]);
    expect([first, second].sort()).toEqual(['merged', 'skipped']);
  });
});

describe('PR checks in the app', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('opening the chat moves a work whose PR is merged to mergeada', async () => {
    const asked: string[] = [];
    const made = makeApp({}, undefined, {
      branchPrs: () => Promise.reject(new Error('not asked: the pilot kept the PR')),
      prState: (_cwd, url) => {
        asked.push(url);
        return Promise.resolve('MERGED');
      },
    });
    app = made.app;
    await made.app.ready();
    // The polling is off in tests: nothing was asked before the chat is opened.
    expect(asked).toEqual([]);
    const user = await new UserRepository(made.db).create('alice', PASSWORD);
    const { token } = new SessionService(made.db, {
      idleTtlSeconds: 1800,
      absoluteTtlSeconds: 43200,
    }).create(user.id);
    const project = await new ProjectRepository(made.db).add({
      name: 'demo',
      repoPath: makeKyroRepo(),
      baseBranch: 'main',
    });
    const chats = new ChatRepository(made.db);
    const states = new WorktreeStateRepository(made.db, chats, new ChatEventBus());
    const runs = new AutopilotRunRepository(made.db);
    const chat = chats.create({
      projectId: project.id,
      kind: 'work',
      slug: 'merged',
      title: 'merged',
      worktreePath: mkdtempSync(join(tmpdir(), 'panel-wt-')),
      branch: 'feature/merged',
      status: 'idle',
    });
    states.transition(chat.id, { state: 'pr_lista', actor: 'pilot' });
    runs.create(chat.id);
    runs.setPrUrls(chat.id, [ROOT]);
    const res = await made.app.inject({
      url: `/api/chats/${String(chat.id)}/pr`,
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ urls: [ROOT] });
    expect(asked).toEqual([ROOT]);
    expect(states.get(chat.id)?.state).toBe('mergeada');
  });

  it('polls every PILOT_PR_POLL_MINUTES minutes by default and 0 turns it off', () => {
    expect(loadConfig({ ...TEST_ENV, PILOT_PR_POLL_MINUTES: '' }).pilotPrPollMs).toBe(5 * 60_000);
    expect(loadConfig({ ...TEST_ENV, PILOT_PR_POLL_MINUTES: '2' }).pilotPrPollMs).toBe(2 * 60_000);
    expect(loadConfig(TEST_ENV).pilotPrPollMs).toBe(0);
    expect(() => loadConfig({ ...TEST_ENV, PILOT_PR_POLL_MINUTES: '-1' })).toThrow(ConfigError);
  });
});
