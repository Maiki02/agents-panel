import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { WorktreeStatus } from '@agents-panel/shared';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { ChatRepository } from '../src/chats/repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { FakeRunner } from './fake-runner.js';
import { PASSWORD, makeApp, makeGitRepo, makeRepoWithRemote, mutatingHeaders } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(setupCommand?: string) {
  const runner = new FakeRunner();
  const made = makeApp({}, undefined, { runner });
  app = made.app;
  await made.app.ready();
  const user = await new UserRepository(made.db).create('alice', PASSWORD);
  const { token, csrfToken } = new SessionService(made.db, {
    idleTtlSeconds: 1800,
    absoluteTtlSeconds: 43200,
  }).create(user.id);
  const cookie = `${SESSION_COOKIE}=${token}`;
  const headers = mutatingHeaders(cookie, csrfToken);
  const project = await new ProjectRepository(made.db).add({
    name: 'demo',
    repoPath: makeGitRepo(),
    baseBranch: 'main',
    ...(setupCommand ? { setupCommand } : {}),
  });
  const work = makeRepoWithRemote('feature/x');
  const chat = new ChatRepository(made.db).create({
    projectId: project.id,
    kind: 'work',
    slug: 'x',
    title: 'x',
    worktreePath: work.repo,
    branch: 'feature/x',
    status: 'idle',
  });
  const post = (path: string, payload: unknown = {}, h = headers) =>
    made.app.inject({
      method: 'POST',
      url: `/api/chats/${String(chat.id)}/${path}`,
      headers: h,
      payload: payload as object,
    });
  return { ...made, runner, cookie, headers, chat, work, post };
}

describe('git routes by chat', () => {
  it('GET answers the status per repo', async () => {
    const s = await boot();
    writeFileSync(join(s.work.repo, 'new.txt'), 'x');
    const res = await s.app.inject({
      url: `/api/chats/${String(s.chat.id)}/git`,
      headers: s.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<WorktreeStatus>();
    expect(body.repos[0]).toMatchObject({ path: '.', branch: 'feature/x', baseBranch: 'main' });
    expect(body.repos[0]?.files.map((f) => f.path)).toContain('new.txt');
  });

  it('404s an unknown chat on every route', async () => {
    const s = await boot();
    const get = await s.app.inject({ url: '/api/chats/9999/git', headers: s.headers });
    expect(get.statusCode).toBe(404);
    for (const path of ['git/pull-base', 'git/pull-branch', 'git/push', 'setup']) {
      const res = await s.app.inject({
        method: 'POST',
        url: `/api/chats/9999/${path}`,
        headers: s.headers,
        payload: {},
      });
      expect(res.statusCode, path).toBe(404);
    }
  });

  it('commit: 404 for a repo that is not of the work, 400 for empty or invalid input', async () => {
    const s = await boot();
    writeFileSync(join(s.work.repo, 'b.txt'), 'b');
    const message = 'feat: b';
    expect(
      (await s.post('git/commit', { repo: 'nope', files: ['b.txt'], message })).statusCode,
    ).toBe(404);
    const invalid = [
      { repo: '.', files: [], message },
      { repo: '.', files: ['b.txt'], message: '' },
      { repo: '.', files: ['b.txt'], message: '   ' },
      { repo: '.', files: ['b.txt'] },
      { repo: '.', files: [''], message },
      { repo: '.', files: ['../x'], message },
      { repo: '.', files: ['/etc/passwd'], message },
      { repo: '/tmp', files: ['b.txt'], message },
      { repo: '../other', files: ['b.txt'], message },
      { repo: '..', files: ['b.txt'], message },
      { repo: 'a/b', files: ['b.txt'], message },
      { repo: '.', files: ['b.txt'], message, extra: 1 },
      { repo: '.', files: ['b.txt'], message: 'x'.repeat(5001) },
    ];
    for (const payload of invalid) {
      const res = await s.post('git/commit', payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
    }
    const ok = await s.post('git/commit', { repo: '.', files: ['b.txt'], message });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ path: '.', result: 'ok' });
    expect(s.work.git(s.work.repo, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe(
      'b.txt',
    );
  });

  it('pull and push: 404 for a repo that is not of the work, 400 for a free path', async () => {
    const s = await boot();
    for (const path of ['git/pull-base', 'git/pull-branch', 'git/push']) {
      expect((await s.post(path, { repo: 'nope' })).statusCode, path).toBe(404);
      expect((await s.post(path, { repo: '../x' })).statusCode, path).toBe(400);
      expect((await s.post(path, { repo: '.', force: true })).statusCode, path).toBe(400);
    }
  });

  it('push leaves the branch on the bare remote, and a remote that is ahead answers 422 with git output', async () => {
    const s = await boot();
    const res = await s.post('git/push');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ repos: { result: string }[] }>().repos[0]?.result).toBe('ok');
    const head = s.work.git(s.work.repo, 'rev-parse', 'HEAD').trim();
    expect(s.work.remoteRef('refs/heads/feature/x')).toBe(head);

    s.work.pushFromOther('r.txt', 'remote', 'feature/x');
    const remoteAhead = s.work.remoteRef('refs/heads/feature/x');
    writeFileSync(join(s.work.repo, 'l.txt'), 'l');
    await s.post('git/commit', { repo: '.', files: ['l.txt'], message: 'feat: l' });
    const rejected = await s.post('git/push', { repo: '.' });
    expect(rejected.statusCode).toBe(422);
    const body = rejected.json<{ error: string; repos: { result: string; output: string }[] }>();
    expect(body.error).toContain('git push');
    expect(body.repos[0]?.result).toBe('error');
    expect(s.work.remoteRef('refs/heads/feature/x')).toBe(remoteAhead);
  });

  it('a pull that conflicts answers 200 with the files and aborts', async () => {
    const s = await boot();
    s.work.pushFromOther('a.txt', 'remoto', 'main');
    const res = await s.post('git/pull-base', {});
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      repos: { result: string; conflicts: string[]; askAgent: boolean }[];
    }>();
    expect(body.repos[0]).toMatchObject({
      result: 'conflict',
      conflicts: ['a.txt'],
      askAgent: true,
    });
    expect(existsSync(join(s.work.repo, '.git', 'MERGE_HEAD'))).toBe(false);
  });

  it('setup runs the project setup', async () => {
    const s = await boot('touch setup-ran');
    const res = await s.post('setup');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ path: '.', result: 'ok' });
    expect(existsSync(join(s.work.repo, 'setup-ran'))).toBe(true);
  });

  it('answers 409 with the reason while the agent runs and leaves the repo alone', async () => {
    const s = await boot();
    let release: () => void = () => undefined;
    s.runner.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent = await s.post('messages', { text: 'hola' });
    expect(sent.statusCode).toBe(202);
    writeFileSync(join(s.work.repo, 'b.txt'), 'b');
    const before = s.work.git(s.work.repo, 'rev-parse', 'HEAD');
    const calls = [
      s.post('git/commit', { repo: '.', files: ['b.txt'], message: 'feat: b' }),
      s.post('git/pull-base'),
      s.post('git/pull-branch'),
      s.post('git/push'),
      s.post('setup'),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toContain('agente');
    }
    expect(s.work.git(s.work.repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(() => s.work.remoteRef('refs/heads/feature/x')).toThrow();
    release();
  });

  it('answers 409 with the pilot active, and works once paused', async () => {
    const s = await boot();
    s.db
      .prepare(
        "INSERT INTO autopilot_runs (chat_id, status, created_at, updated_at) VALUES (?, 'active', 1, 1)",
      )
      .run(s.chat.id);
    const blocked = await s.post('git/push');
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ error: string }>().error).toContain('active');
    expect(() => s.work.remoteRef('refs/heads/feature/x')).toThrow();
    s.db.prepare("UPDATE autopilot_runs SET status = 'paused' WHERE chat_id = ?").run(s.chat.id);
    expect((await s.post('git/push')).statusCode).toBe(200);
  });
});
