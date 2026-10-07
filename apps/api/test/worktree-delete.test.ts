import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DeletePreview, DeleteWorkOutcome } from '@agents-panel/shared';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { ChatRepository } from '../src/chats/repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { createGit } from '../src/pilot/git-ops.js';
import { FakeRunner } from './fake-runner.js';
import { PASSWORD, makeApp, makeRepoWithRemote, mutatingHeaders } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** A project with a bare origin and a real worktree of it on feature/x with one unpushed commit. */
async function boot() {
  const runner = new FakeRunner();
  const made = makeApp({}, undefined, { runner });
  app = made.app;
  await made.app.ready();
  const user = await new UserRepository(made.db).create('alice', PASSWORD);
  const { token, csrfToken } = new SessionService(made.db, {
    idleTtlSeconds: 1800,
    absoluteTtlSeconds: 43200,
  }).create(user.id);
  const headers = mutatingHeaders(`${SESSION_COOKIE}=${token}`, csrfToken);
  const origin = makeRepoWithRemote('feature/seed');
  origin.git(origin.repo, 'checkout', '-q', 'main');
  const project = await new ProjectRepository(made.db).add({
    name: 'demo',
    repoPath: origin.repo,
    baseBranch: 'main',
  });
  const worktree = join(mkdtempSync(join(tmpdir(), 'panel-wt-')), 'x');
  origin.git(origin.repo, 'worktree', 'add', '-q', worktree, '-b', 'feature/x', 'main');
  writeFileSync(join(worktree, 'work.txt'), 'w');
  origin.git(worktree, 'add', '.');
  origin.git(worktree, 'commit', '-q', '-m', 'feat: work');
  writeFileSync(join(worktree, 'loose.txt'), 'l');
  const chat = new ChatRepository(made.db).create({
    projectId: project.id,
    kind: 'work',
    slug: 'x',
    title: 'x',
    worktreePath: worktree,
    branch: 'feature/x',
    status: 'idle',
  });
  const url = (path: string) => `/api/chats/${String(chat.id)}/${path}`;
  const post = (path: string, payload: unknown = {}) =>
    made.app.inject({ method: 'POST', url: url(path), headers, payload: payload as object });
  const preview = () => made.app.inject({ url: url('work/delete-preview'), headers });
  const state = () =>
    (
      made.db.prepare('SELECT state FROM worktree_state WHERE chat_id = ?').get(chat.id) as
        { state: string } | undefined
    )?.state;
  const branches = (dir: string) => origin.git(dir, 'branch', '--format=%(refname:short)');
  return { ...made, runner, headers, chat, origin, worktree, post, preview, state, branches, url };
}

describe('delete work (D28)', () => {
  it('the preview warns of the unpushed commits and the uncommitted files', async () => {
    const s = await boot();
    const res = await s.preview();
    expect(res.statusCode).toBe(200);
    const body = res.json<DeletePreview>();
    expect(body.worktreePath).toBe(s.worktree);
    expect(body.repos).toEqual([
      {
        path: '.',
        branch: 'feature/x',
        remoteExists: false,
        unpushedCommits: 1,
        uncommittedFiles: ['loose.txt'],
        error: null,
      },
    ]);
    // Pushed: origin has it and nothing is unpushed any more.
    s.origin.git(s.worktree, 'push', '-q', 'origin', 'feature/x');
    const pushed = (await s.preview()).json<DeletePreview>();
    expect(pushed.repos[0]).toMatchObject({ remoteExists: true, unpushedCommits: 0 });
  });

  it('answers 409 and deletes nothing while the agent runs', async () => {
    const s = await boot();
    let release: () => void = () => undefined;
    s.runner.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    expect((await s.post('messages', { text: 'hola' })).statusCode).toBe(202);
    const res = await s.post('work/delete', { deleteRemote: true });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toContain('agente');
    expect(existsSync(s.worktree)).toBe(true);
    expect(s.branches(s.origin.repo)).toContain('feature/x');
    expect(s.state()).not.toBe('archivado');
    release();
  });

  it('answers 409 while the pilot is busy', async () => {
    const s = await boot();
    s.db
      .prepare(
        "INSERT INTO autopilot_runs (chat_id, status, created_at, updated_at) VALUES (?, 'active', 1, 1)",
      )
      .run(s.chat.id);
    expect((await s.post('work/delete', { deleteRemote: false })).statusCode).toBe(409);
    expect(existsSync(s.worktree)).toBe(true);
  });

  it('without deleteRemote it removes the worktree and the local branch and keeps the remote', async () => {
    const s = await boot();
    s.origin.git(s.worktree, 'push', '-q', 'origin', 'feature/x');
    s.db
      .prepare(
        "INSERT INTO autopilot_runs (chat_id, status, created_at, updated_at) VALUES (?, 'paused', 1, 1)",
      )
      .run(s.chat.id);
    const res = await s.post('work/delete', { deleteRemote: false });
    expect(res.statusCode).toBe(200);
    expect(res.json<DeleteWorkOutcome>().state).toBe('archivado');
    expect(existsSync(s.worktree)).toBe(false);
    expect(s.branches(s.origin.repo)).not.toContain('feature/x');
    expect(s.branches(s.origin.repo)).toContain('main');
    expect(s.origin.remoteRef('refs/heads/feature/x')).not.toBe('');
    expect(s.state()).toBe('archivado');
    const run = s.db.prepare('SELECT status FROM autopilot_runs WHERE chat_id = ?').get(s.chat.id);
    expect(run).toEqual({ status: 'off' });
  });

  it('with deleteRemote it also deletes the remote branch, never the base', async () => {
    const s = await boot();
    s.origin.git(s.worktree, 'push', '-q', 'origin', 'feature/x');
    const res = await s.post('work/delete', { deleteRemote: true });
    expect(res.statusCode).toBe(200);
    expect(res.json<DeleteWorkOutcome>().steps.join('\n')).toContain('Rama remota borrada');
    expect(() => s.origin.remoteRef('refs/heads/feature/x')).toThrow();
    expect(s.origin.remoteRef('refs/heads/main')).not.toBe('');
    expect(existsSync(s.worktree)).toBe(false);
  });

  it('after deleting, the chat is archived and read only', async () => {
    const s = await boot();
    expect((await s.post('work/delete', { deleteRemote: false })).statusCode).toBe(200);
    const calls = [
      s.post('messages', { text: 'hola' }),
      s.post('steps', { step: 'plan' }),
      s.post('autopilot', { action: 'on' }),
      s.post('git/push'),
      s.post('git/pull-base'),
      s.post('setup'),
      s.post('work/delete', { deleteRemote: false }),
      s.preview(),
      s.app.inject({ url: s.url('git'), headers: s.headers }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json<{ error: string }>().error).toContain('archivado');
    }
  });

  it('a failure halfway leaves the work in revisar with the detail', async () => {
    const s = await boot();
    // The worktree folder becomes something git cannot remove: the project repo is gone.
    s.origin.git(s.origin.repo, 'worktree', 'lock', s.worktree);
    const res = await s.post('work/delete', { deleteRemote: false });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toContain('El borrado falló');
    expect(s.state()).toBe('revisar');
    const detail = s.db
      .prepare('SELECT detail FROM worktree_state WHERE chat_id = ?')
      .get(s.chat.id) as { detail: string };
    expect(detail.detail).toContain('worktree');
    expect(existsSync(s.worktree)).toBe(true);
  });

  it('rejects bad bodies', async () => {
    const s = await boot();
    for (const payload of [{}, { deleteRemote: 'yes' }, { deleteRemote: true, extra: 1 }]) {
      expect((await s.post('work/delete', payload)).statusCode).toBe(400);
    }
    expect(existsSync(s.worktree)).toBe(true);
  });
});

describe('git deleteRemoteBranch', () => {
  it('refuses the base and invalid names without touching origin', async () => {
    const calls: string[][] = [];
    const git = createGit((_file, args) => {
      calls.push(args);
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    await expect(git.deleteRemoteBranch('/x', 'main', 'main')).rejects.toThrow('base');
    await expect(git.deleteRemoteBranch('/x', '--all', 'main')).rejects.toThrow();
    await expect(git.deleteRemoteBranch('/x', 'a:b', 'main')).rejects.toThrow();
    expect(calls).toEqual([]);
    await git.deleteRemoteBranch('/x', 'feature/x', 'main');
    expect(calls).toEqual([['-C', '/x', 'push', 'origin', '--delete', 'feature/x']]);
  });
});
