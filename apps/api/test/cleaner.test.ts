import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DeletePreview, DeleteRepoPreview } from '@agents-panel/shared';
import { ChatEventBus } from '../src/chats/events.js';
import { ChatRepository } from '../src/chats/repo.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { WorktreeCleaner, deleteBlockers } from '../src/worktrees/cleaner.js';
import { WorktreeOpsError } from '../src/worktrees/ops.js';
import { WorktreeStateRepository } from '../src/worktrees/state-repo.js';
import { FakeRunner } from './fake-runner.js';
import { TEST_ENV, makeApp, makeGitRepo, makeRepoWithRemote } from './helpers.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-06-10T12:00:00Z');
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function repoPreview(over: Partial<DeleteRepoPreview> = {}): DeleteRepoPreview {
  return {
    path: '.',
    branch: 'feature/x',
    remoteExists: true,
    unpushedCommits: 0,
    uncommittedFiles: [],
    error: null,
    ...over,
  };
}

/** The cleaner over a real database and a scripted `WorktreeOps`. */
function fakeSetup(hours = 24) {
  const db = openDatabase(':memory:');
  const chats = new ChatRepository(db);
  const states = new WorktreeStateRepository(db, chats, new ChatEventBus());
  const projects = new ProjectRepository(db);
  const calls: string[] = [];
  const script = {
    idle: null as WorktreeOpsError | null,
    preview: [repoPreview()] as DeleteRepoPreview[],
    deleteError: null as Error | null,
  };
  const ops = {
    assertIdle: (id: number) => {
      calls.push(`idle:${String(id)}`);
      if (script.idle) throw script.idle;
    },
    deletePreview: (id: number): Promise<DeletePreview> => {
      calls.push(`preview:${String(id)}`);
      return Promise.resolve({ chatId: id, worktreePath: '/x', repos: script.preview });
    },
    deleteWork: (id: number, remote: boolean, actor: string) => {
      calls.push(`delete:${String(id)}:${String(remote)}:${actor}`);
      if (script.deleteError) return Promise.reject(script.deleteError);
      states.transition(id, { state: 'archivado', actor: 'pilot', reason: 'Trabajo borrado' });
      return Promise.resolve({ chatId: id, state: 'archivado' as const, steps: [] });
    },
  };
  const cleaner = new WorktreeCleaner({
    chats,
    states,
    ops: ops as never,
    afterMergeHours: hours,
    now: () => NOW,
  });
  const newMerged = async (slug: string, mergedHoursAgo: number | null) => {
    const project =
      projects.list()[0] ??
      (await projects.add({ name: 'demo', repoPath: makeGitRepo(), baseBranch: 'main' }));
    const chat = chats.create({
      projectId: project.id,
      kind: 'work',
      slug,
      title: slug,
      worktreePath: mkdtempSync(join(tmpdir(), 'panel-wt-')),
      branch: `feature/${slug}`,
      status: 'idle',
    });
    states.transition(chat.id, { state: 'mergeada', actor: 'pilot', phase: 'cierre', taskDone: 3 });
    if (mergedHoursAgo !== null) chats.setMergedAt(chat.id, ago(mergedHoursAgo));
    return chat;
  };
  return { cleaner, states, script, calls, newMerged };
}

describe('WorktreeCleaner rounds', () => {
  it('deletes a work merged more than 24 hours ago, with the remote branch, as the pilot', async () => {
    const s = fakeSetup();
    const chat = await s.newMerged('old', 25);
    expect(await s.cleaner.cleanAll()).toEqual(new Map([[chat.id, 'deleted']]));
    expect(s.calls).toContain(`delete:${String(chat.id)}:true:pilot`);
    expect(s.states.get(chat.id)?.state).toBe('archivado');
  });

  it('leaves alone a work merged less than 24 hours ago, or without merged_at', async () => {
    const s = fakeSetup();
    const recent = await s.newMerged('recent', 23);
    const unknown = await s.newMerged('unknown', null);
    const results = await s.cleaner.cleanAll();
    expect(results.get(recent.id)).toBe('too_soon');
    expect(results.get(unknown.id)).toBe('too_soon');
    expect(s.calls).toEqual([]);
    expect(s.states.get(recent.id)?.state).toBe('mergeada');
  });

  it('sends to revisar, with the detail, a work with uncommitted files or unpushed commits', async () => {
    const s = fakeSetup();
    s.script.preview = [
      repoPreview({ uncommittedFiles: ['a.txt', 'b.txt'] }),
      repoPreview({ path: 'fe', unpushedCommits: 2 }),
    ];
    const chat = await s.newMerged('dirty', 30);
    expect((await s.cleaner.cleanAll()).get(chat.id)).toBe('reviewed');
    expect(s.calls.some((c) => c.startsWith('delete:'))).toBe(false);
    const state = s.states.get(chat.id);
    expect(state).toMatchObject({ state: 'revisar', actor: 'pilot', phase: 'cierre', taskDone: 3 });
    expect(state?.detail).toContain('.: 2 archivo(s) sin commitear');
    expect(state?.detail).toContain('fe: 2 commit(s) sin pushear');
    expect(s.states.timeline(chat.id).at(-1)).toMatchObject({ toState: 'revisar', actor: 'pilot' });
    // Out of mergeada: the next round does not look at it again.
    s.calls.length = 0;
    await s.cleaner.cleanAll();
    expect(s.calls).toEqual([]);
  });

  it('does not delete when origin could not be asked', () => {
    expect(
      deleteBlockers({ chatId: 1, worktreePath: '/x', repos: [repoPreview({ error: 'sin red' })] }),
    ).toContain('sin red');
    expect(deleteBlockers({ chatId: 1, worktreePath: '/x', repos: [repoPreview()] })).toBeNull();
  });

  it('skips a busy work (409) keeping its state and retries it in the next round', async () => {
    const s = fakeSetup();
    const chat = await s.newMerged('busy', 26);
    s.script.idle = new WorktreeOpsError('El agente de este trabajo está corriendo', 409);
    expect((await s.cleaner.cleanAll()).get(chat.id)).toBe('busy');
    expect(s.states.get(chat.id)?.state).toBe('mergeada');
    expect(s.states.timeline(chat.id)).toHaveLength(1);
    expect(s.calls.some((c) => c.startsWith('delete:'))).toBe(false);
    s.script.idle = null;
    expect((await s.cleaner.cleanAll()).get(chat.id)).toBe('deleted');
  });

  it('also skips when the delete itself answers 409 (another operation on the work)', async () => {
    const s = fakeSetup();
    const chat = await s.newMerged('locked', 26);
    s.script.deleteError = new WorktreeOpsError('Ya hay una operación en curso', 409);
    expect((await s.cleaner.cleanAll()).get(chat.id)).toBe('busy');
    expect(s.states.get(chat.id)?.state).toBe('mergeada');
  });

  it('another error leaves the work in revisar, and one failing work does not stop the round', async () => {
    const s = fakeSetup();
    const bad = await s.newMerged('bad', 40);
    const good = await s.newMerged('good', 40);
    s.script.deleteError = new Error('disco lleno');
    const first = await s.cleaner.cleanAll();
    expect(first.get(bad.id)).toBe('failed');
    expect(first.get(good.id)).toBe('failed');
    expect(s.states.get(bad.id)).toMatchObject({ state: 'revisar', actor: 'pilot' });
    expect(s.states.get(bad.id)?.detail).toContain('disco lleno');
    // Works go one at a time, in order.
    expect(s.calls.filter((c) => c.startsWith('delete:'))).toEqual([
      `delete:${String(bad.id)}:true:pilot`,
      `delete:${String(good.id)}:true:pilot`,
    ]);
  });

  it('with 0 hours it does nothing', async () => {
    const s = fakeSetup(0);
    await s.newMerged('old', 100);
    expect((await s.cleaner.cleanAll()).size).toBe(0);
    s.cleaner.start(1000);
    s.cleaner.stop();
    expect(s.calls).toEqual([]);
  });
});

describe('PANEL_CLEANUP_AFTER_MERGE_HOURS', () => {
  it('defaults to 24 and 0 turns it off', () => {
    const base: Record<string, string> = { ...TEST_ENV };
    delete base['PANEL_CLEANUP_AFTER_MERGE_HOURS'];
    expect(loadConfig(base).cleanupAfterMergeHours).toBe(24);
    expect(
      loadConfig({ ...base, PANEL_CLEANUP_AFTER_MERGE_HOURS: '6' }).cleanupAfterMergeHours,
    ).toBe(6);
    expect(loadConfig(TEST_ENV).cleanupAfterMergeHours).toBe(0);
  });
});

/** The real service: a project with a bare origin and a worktree on feature/x merged long ago. */
async function boot(hours: string, pushed: boolean, loose: boolean) {
  const db = openDatabase(':memory:');
  const origin = makeRepoWithRemote('feature/seed');
  origin.git(origin.repo, 'checkout', '-q', 'main');
  const project = await new ProjectRepository(db).add({
    name: 'demo',
    repoPath: origin.repo,
    baseBranch: 'main',
  });
  const worktree = join(mkdtempSync(join(tmpdir(), 'panel-wt-')), 'x');
  origin.git(origin.repo, 'worktree', 'add', '-q', worktree, '-b', 'feature/x', 'main');
  writeFileSync(join(worktree, 'work.txt'), 'w');
  origin.git(worktree, 'add', '.');
  origin.git(worktree, 'commit', '-q', '-m', 'feat: work');
  if (pushed) origin.git(worktree, 'push', '-q', 'origin', 'feature/x');
  if (loose) writeFileSync(join(worktree, 'loose.txt'), 'l');
  const chats = new ChatRepository(db);
  const chat = chats.create({
    projectId: project.id,
    kind: 'work',
    slug: 'x',
    title: 'x',
    worktreePath: worktree,
    branch: 'feature/x',
    status: 'idle',
  });
  const states = new WorktreeStateRepository(db, chats, new ChatEventBus());
  states.transition(chat.id, { state: 'mergeada', actor: 'pilot' });
  chats.setMergedAt(chat.id, new Date(Date.now() - 25 * HOUR).toISOString());
  chats.appendEvent(chat.id, 'note', {});
  // The cleaner runs by itself when the API starts.
  const made = makeApp({ PANEL_CLEANUP_AFTER_MERGE_HOURS: hours }, undefined, {
    db,
    runner: new FakeRunner(),
  });
  app = made.app;
  await made.app.ready();
  const settled = async () => {
    for (let i = 0; i < 100; i += 1) {
      const state = states.get(chat.id)?.state;
      if (state !== 'mergeada' && state !== 'limpiando') return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  return { db, origin, worktree, chat, states, settled };
}

describe('WorktreeCleaner at startup (real git)', () => {
  it('archives the work, deleting the folder and the local and remote branches, and keeps its history', async () => {
    const s = await boot('24', true, false);
    await s.settled();
    expect(s.states.get(s.chat.id)?.state).toBe('archivado');
    expect(existsSync(s.worktree)).toBe(false);
    expect(s.origin.git(s.origin.repo, 'branch', '--format=%(refname:short)')).not.toContain(
      'feature/x',
    );
    expect(() => s.origin.remoteRef('refs/heads/feature/x')).toThrow();
    expect(s.origin.remoteRef('refs/heads/main')).not.toBe('');
    // The chat, its events and the Timeline stay, with the cleanup under the pilot.
    expect(new ChatRepository(s.db).findById(s.chat.id)?.slug).toBe('x');
    expect(
      s.db
        .prepare("SELECT COUNT(*) AS n FROM chat_events WHERE chat_id = ? AND type = 'note'")
        .get(s.chat.id),
    ).toEqual({ n: 1 });
    const timeline = s.states.timeline(s.chat.id);
    expect(timeline.at(-1)).toMatchObject({ toState: 'archivado', actor: 'pilot' });
    expect(timeline.some((t) => t.toState === 'limpiando' && t.actor === 'pilot')).toBe(true);
  });

  it('keeps a work with uncommitted files and sends it to revisar', async () => {
    const s = await boot('24', true, true);
    await s.settled();
    expect(s.states.get(s.chat.id)).toMatchObject({ state: 'revisar', actor: 'pilot' });
    expect(s.states.get(s.chat.id)?.detail).toContain('sin commitear');
    expect(existsSync(s.worktree)).toBe(true);
    expect(s.origin.git(s.origin.repo, 'branch', '--format=%(refname:short)')).toContain(
      'feature/x',
    );
  });

  it('keeps a work with unpushed commits and sends it to revisar', async () => {
    const s = await boot('24', false, false);
    await s.settled();
    expect(s.states.get(s.chat.id)?.state).toBe('revisar');
    expect(s.states.get(s.chat.id)?.detail).toContain('sin pushear');
    expect(existsSync(s.worktree)).toBe(true);
  });

  it('with 0 hours the API start deletes nothing', async () => {
    const s = await boot('0', true, false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(s.states.get(s.chat.id)?.state).toBe('mergeada');
    expect(existsSync(s.worktree)).toBe(true);
  });
});
