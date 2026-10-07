import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RepoDiff } from '@agents-panel/shared';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { ChatRepository } from '../src/chats/repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { PASSWORD, makeApp, makeGitRepo, makeRepoWithRemote, mutatingHeaders } from './helpers.js';

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
    repoPath: makeGitRepo(),
    baseBranch: 'main',
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
  const get = (query: string) =>
    made.app.inject({
      url: `/api/chats/${String(chat.id)}/git/diff?${query}`,
      headers,
    });
  return { work, get, headers, chat };
}

describe('GET /api/chats/:id/git/diff', () => {
  it('uncommitted: lists the modified and the new file, never the ignored .env (S13)', async () => {
    const s = await boot();
    appendFileSync(join(s.work.repo, '.gitignore'), '.env\n');
    s.work.git(s.work.repo, 'add', '.gitignore');
    s.work.git(s.work.repo, 'commit', '-q', '-m', 'chore: ignore env');
    writeFileSync(join(s.work.repo, 'a.txt'), 'changed\n');
    writeFileSync(join(s.work.repo, 'new.txt'), 'one\ntwo\n');
    writeFileSync(join(s.work.repo, '.env'), 'SECRET=1\n');

    const res = await s.get('repo=.&against=worktree');
    expect(res.statusCode).toBe(200);
    const body = res.json<RepoDiff>();
    expect(body.files.map((f) => f.path).sort()).toEqual(['a.txt', 'new.txt']);
    const added = body.files.find((f) => f.path === 'new.txt');
    expect(added).toMatchObject({ status: 'untracked', additions: 2, binary: false });
    expect(added?.patch).toContain('+two');
    const modified = body.files.find((f) => f.path === 'a.txt');
    expect(modified).toMatchObject({ status: 'modified', additions: 1, deletions: 1 });
    expect(res.body).not.toContain('SECRET');
  });

  it('hides a tracked file that is ignored', async () => {
    const s = await boot();
    writeFileSync(join(s.work.repo, '.env'), 'A=1\n');
    s.work.git(s.work.repo, 'add', '-f', '.env');
    s.work.git(s.work.repo, 'commit', '-q', '-m', 'oops');
    appendFileSync(join(s.work.repo, '.gitignore'), '.env\n');
    writeFileSync(join(s.work.repo, '.env'), 'A=2 SECRET\n');
    const res = await s.get('repo=.&against=worktree');
    expect(res.json<RepoDiff>().files.map((f) => f.path)).toEqual(['.gitignore']);
    expect(res.body).not.toContain('SECRET');
    const base = await s.get('repo=.&against=base');
    expect(base.json<RepoDiff>().files.map((f) => f.path)).not.toContain('.env');
  });

  it('against the base: the files of the commits of the work', async () => {
    const s = await boot();
    const res = await s.get('repo=.&against=base');
    expect(res.statusCode).toBe(200);
    const body = res.json<RepoDiff>();
    expect(body.baseBranch).toBe('main');
    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({ path: 'a.txt', status: 'added', additions: 1 });
  });

  it('cuts a long patch with truncated and returns it whole with file', async () => {
    const s = await boot();
    const long = Array.from({ length: 4000 }, (_, i) => `line ${String(i)}`).join('\n');
    writeFileSync(join(s.work.repo, 'big.txt'), long);
    const list = (await s.get('repo=.&against=worktree')).json<RepoDiff>();
    const cut = list.files.find((f) => f.path === 'big.txt');
    expect(cut?.truncated).toBe(true);
    expect(cut?.patch.length).toBe(20_000);
    const one = (await s.get('repo=.&against=worktree&file=big.txt')).json<RepoDiff>();
    expect(one.files).toHaveLength(1);
    expect(one.files[0]?.truncated).toBe(false);
    expect(one.files[0]?.patch).toContain('+line 3999');
  });

  it('marks a binary file without a patch', async () => {
    const s = await boot();
    writeFileSync(join(s.work.repo, 'img.bin'), Buffer.from([0, 1, 2, 0, 255]));
    const body = (await s.get('repo=.&against=worktree')).json<RepoDiff>();
    expect(body.files.find((f) => f.path === 'img.bin')).toMatchObject({
      binary: true,
      patch: '',
    });
  });

  it('400s an ignored, absolute or ".." file, and a bad query', async () => {
    const s = await boot();
    appendFileSync(join(s.work.repo, '.gitignore'), '.env\n');
    writeFileSync(join(s.work.repo, '.env'), 'X=1\n');
    for (const file of [
      '.env',
      '/etc/passwd',
      '../outside.txt',
      'a/../../b',
      encodeURIComponent('a/..'),
    ]) {
      const res = await s.get(`repo=.&against=worktree&file=${file}`);
      expect(res.statusCode, file).toBe(400);
    }
    expect((await s.get('repo=.&against=nope')).statusCode).toBe(400);
    expect((await s.get('against=base')).statusCode).toBe(400);
    expect((await s.get('repo=..&against=base')).statusCode).toBe(400);
  });

  it('404s a repo that is not part of the work and needs a session', async () => {
    const s = await boot();
    expect((await s.get('repo=other&against=base')).statusCode).toBe(404);
    const anon = await app?.inject({
      url: `/api/chats/${String(s.chat.id)}/git/diff?repo=.&against=base`,
    });
    expect(anon?.statusCode).toBe(401);
  });
});
