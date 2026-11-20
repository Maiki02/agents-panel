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
import type { FetchLike } from '../src/forge/gitlab-api.js';
import { ForgeRegistry } from '../src/forge/provider.js';
import { prStateOf, type PrState, type PrStatus } from '../src/pilot/github-cli.js';
import { migrations, runMigrations } from '../src/db/migrations.js';
import { DatabaseSync } from 'node:sqlite';
import { PrLookup } from '../src/pilot/pr-lookup.js';
import { fakeGitlab } from './fake-gitlab.js';
import { PrWatcher } from '../src/pilot/pr-watcher.js';
import { AutopilotRunRepository } from '../src/pilot/runs-repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { WorktreeStateRepository } from '../src/worktrees/state-repo.js';
import { PASSWORD, TEST_ENV, makeApp, makeKyroRepo } from './helpers.js';

const ROOT = 'https://github.com/acme/demo/pull/7';
const CHILD = 'https://github.com/acme/demo-fe/pull/3';

async function setup(answers: Record<string, PrState | PrStatus | Error>, urls: string[] = [ROOT]) {
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
  return { watcher, states, newChat, asked, logs, chats };
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

  it('stores the latest merge of its PRs in merged_at (GitHub)', async () => {
    const { watcher, newChat, chats } = await setup(
      {
        [ROOT]: { state: 'MERGED', mergedAt: '2026-11-01T10:00:00.000Z' },
        [CHILD]: { state: 'MERGED', mergedAt: '2026-11-03T09:30:00.000Z' },
      },
      [ROOT, CHILD],
    );
    const chat = newChat('ma', 'pr_lista');
    expect(chats.findById(chat.id)?.mergedAt).toBeNull();
    expect(await watcher.check(chat)).toBe('merged');
    expect(chats.findById(chat.id)?.mergedAt).toBe('2026-11-03T09:30:00.000Z');
  });

  it('falls back to the moment of the detection when the provider reports no merge date', async () => {
    const { watcher, newChat, chats } = await setup({
      [ROOT]: { state: 'MERGED', mergedAt: null },
    });
    const chat = newChat('mb', 'pr_lista');
    const before = Date.now();
    expect(await watcher.check(chat)).toBe('merged');
    const stored = chats.findById(chat.id)?.mergedAt;
    expect(stored).toBeTypeOf('string');
    expect(Date.parse(stored ?? '')).toBeGreaterThanOrEqual(before);
    expect(Date.parse(stored ?? '')).toBeLessThanOrEqual(Date.now());
  });

  it('leaves merged_at empty while the work is not merged', async () => {
    const { watcher, newChat, chats } = await setup({ [ROOT]: 'OPEN' });
    const chat = newChat('mc', 'pr_lista');
    expect(await watcher.check(chat)).toBe('open');
    expect(chats.findById(chat.id)?.mergedAt).toBeNull();
  });

  it('migration 27 adds merged_at and fills it with the since of the works already merged', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(
      db,
      migrations.filter((m) => m.version <= 26),
    );
    db.prepare(
      "INSERT INTO projects (name, repo_path, base_branch, created_at) VALUES ('p', '/r', 'main', 1)",
    ).run();
    const insertChat = (slug: string) =>
      Number(
        db
          .prepare(
            "INSERT INTO chats (project_id, kind, slug, title, worktree_path, branch, status, created_at, updated_at) VALUES (1, 'work', ?, ?, '/w', ?, 'idle', 1, 1)",
          )
          .run(slug, slug, slug).lastInsertRowid,
      );
    const merged = insertChat('merged');
    const open = insertChat('open');
    const insertState = db.prepare(
      "INSERT INTO worktree_state (chat_id, state, actor, since) VALUES (?, ?, 'pilot', ?)",
    );
    insertState.run(merged, 'mergeada', Date.parse('2026-10-05T12:00:00.000Z'));
    insertState.run(open, 'pr_lista', Date.parse('2026-10-06T12:00:00.000Z'));
    expect(runMigrations(db)).toEqual([27]);
    const rows = db.prepare('SELECT id, merged_at FROM chats ORDER BY id').all();
    expect(rows).toEqual([
      { id: merged, merged_at: '2026-10-05T12:00:00.000Z' },
      { id: open, merged_at: null },
    ]);
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

describe('PrWatcher in a GitLab project', () => {
  const GL_TOKEN = 'glpat-xyz';

  function gitlabSetup(fetchOverride?: FetchLike) {
    const db = openDatabase(':memory:');
    const chats = new ChatRepository(db);
    const states = new WorktreeStateRepository(db, chats, new ChatEventBus());
    const projects = new ProjectRepository(db);
    const project = projects.insertGithub({
      name: 'lab',
      displayName: null,
      repoUrl: 'https://gitlab.example.com/g/repo',
      gitProvider: 'gitlab',
      repoPath: makeKyroRepo(),
      baseBranch: 'main',
      setupCommand: null,
      status: 'ready',
      statusDetail: null,
    });
    const gitlab = fakeGitlab('gitlab.example.com', GL_TOKEN);
    const forge = new ForgeRegistry({
      projects,
      credentials: {
        forProject: () => ({ host: 'gitlab.example.com', username: 'u', token: GL_TOKEN }),
      },
      fetch: fetchOverride ?? gitlab.fetchImpl,
    });
    const prs = new PrLookup({ runs: new AutopilotRunRepository(db), states, projects, forge });
    const logs: string[] = [];
    const watcher = new PrWatcher({
      chats,
      states,
      projects,
      prs,
      forge,
      log: (message) => logs.push(message),
    });
    const newChat = (slug: string, mrState: 'opened' | 'merged' | 'closed') => {
      const chat = chats.create({
        projectId: project.id,
        kind: 'work',
        slug,
        title: slug,
        worktreePath: mkdtempSync(join(tmpdir(), 'panel-wt-')),
        branch: `feature/${slug}`,
        status: 'idle',
      });
      states.transition(chat.id, { state: 'pr_lista', actor: 'pilot' });
      gitlab.mrs.push({
        iid: gitlab.mrs.length + 1,
        project: 'g/repo',
        source_branch: `feature/${slug}`,
        target_branch: 'main',
        state: mrState,
        title: 't',
        description: '',
      });
      return chat;
    };
    return { watcher, states, newChat, logs, chats, gitlab };
  }

  it('takes the work to mergeada when the MR is merged, to revisar when closed, and waits while open', async () => {
    const { watcher, states, newChat } = gitlabSetup();
    const merged = newChat('m', 'merged');
    const closed = newChat('c', 'closed');
    const open = newChat('o', 'opened');
    expect(await watcher.check(merged)).toBe('merged');
    expect(await watcher.check(closed)).toBe('closed');
    expect(await watcher.check(open)).toBe('open');
    expect(states.get(merged.id)?.state).toBe('mergeada');
    expect(states.get(closed.id)?.state).toBe('revisar');
    expect(states.get(open.id)?.state).toBe('pr_lista');
  });

  it('stores the merged_at of the MR in GitLab, or the detection when it reports none', async () => {
    const { watcher, newChat, chats, gitlab } = gitlabSetup();
    const dated = newChat('md', 'merged');
    const undated = newChat('mu', 'merged');
    const mr = gitlab.mrs[0];
    if (!mr) throw new Error('no mr');
    mr.merged_at = '2026-11-02T08:15:00.000Z';
    const before = Date.now();
    expect(await watcher.check(dated)).toBe('merged');
    expect(await watcher.check(undated)).toBe('merged');
    expect(chats.findById(dated.id)?.mergedAt).toBe('2026-11-02T08:15:00.000Z');
    expect(Date.parse(chats.findById(undated.id)?.mergedAt ?? '')).toBeGreaterThanOrEqual(before);
  });

  it('a GitLab failure changes nothing and leaves no token in the log or the Timeline', async () => {
    const { watcher, states, newChat, logs } = gitlabSetup(() =>
      Promise.reject(new Error(`connection reset (${GL_TOKEN})`)),
    );
    const chat = newChat('f', 'merged');
    expect(await watcher.check(chat)).toBe('none');
    expect(states.get(chat.id)?.state).toBe('pr_lista');
    expect(JSON.stringify(states.timeline(chat.id))).not.toContain(GL_TOKEN);
    expect(logs.join('\n')).not.toContain(GL_TOKEN);
  });
});
