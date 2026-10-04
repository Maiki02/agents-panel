import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { SecondFactorRepository, generateTotpCode, generateTotpSecret } from '../src/auth/totp.js';
import { UserRepository } from '../src/auth/users.js';
import { ChatRepository } from '../src/chats/repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { PASSWORD, TEST_ENV, makeApp, makeGitRepo, mutatingHeaders } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
});

const SENTINEL = 'S3NT1NEL_ROUTE_VALUE_e5a9';
const CONTENT = `DB_HOST=localhost\nAPI_KEY=${SENTINEL}\n`;
const PERIOD_MS = 30_000;

/** A ready project whose clone ignores .env* and backend/.env but not config/.env. */
async function setup() {
  const state = { t: 1_700_000_000_000 };
  const made = makeApp({}, () => state.t);
  app = made.app;
  await app.ready();
  const server = app;

  const repoPath = makeGitRepo();
  writeFileSync(join(repoPath, '.gitignore'), '/.env*\nbackend/.env\n');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repoPath, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      stdio: 'pipe',
    });
  git('add', '.gitignore');
  // Committed so worktrees of the project inherit the ignore rules.
  git('commit', '-q', '-m', 'ignore env');
  const project = await new ProjectRepository(made.db).add({
    name: 'demo',
    repoPath,
    baseBranch: 'main',
  });

  const user = await new UserRepository(made.db).create('alice', PASSWORD);
  const secret = generateTotpSecret();
  new SecondFactorRepository(made.db, Buffer.from(TEST_ENV.PANEL_SECRET_KEY)).setTotpSecret(
    user.id,
    secret,
  );
  const { token, csrfToken } = new SessionService(
    made.db,
    { idleTtlSeconds: 1800, absoluteTtlSeconds: 43200 },
    () => state.t,
  ).create(user.id);
  const headers = mutatingHeaders(`${SESSION_COOKIE}=${token}`, csrfToken);

  /** A code from a time step never used before. */
  const totp = () => {
    state.t += PERIOD_MS;
    return generateTotpCode(secret, state.t);
  };
  const url = (id = project.id) => `/api/projects/${String(id)}/env`;
  const put = (payload: Record<string, unknown>, id?: number) =>
    server.inject({ method: 'PUT', url: url(id), headers, payload });
  const del = (payload: Record<string, unknown>, id?: number) =>
    server.inject({ method: 'DELETE', url: url(id), headers, payload });
  const list = (id?: number) => server.inject({ url: url(id), headers });
  const rows = () => made.db.prepare('SELECT * FROM project_env_files ORDER BY id').all();
  const chats = new ChatRepository(made.db);
  /** A chat with a real worktree of the project on feature/<slug>. */
  const addChat = (slug: string) => {
    const worktreePath = join(mkdtempSync(join(tmpdir(), 'panel-apply-')), slug);
    git('worktree', 'add', '-q', '-b', `feature/${slug}`, worktreePath);
    return chats.create({
      projectId: project.id,
      kind: 'work',
      slug,
      title: slug,
      worktreePath,
      branch: `feature/${slug}`,
      status: 'idle',
    });
  };
  return { state, db: made.db, server, project, totp, put, del, list, rows, headers, addChat };
}

describe('env file routes', () => {
  it('creates (201), replaces (200) and lists metadata without ever returning the content', async () => {
    const { put, list, totp, rows } = await setup();

    const created = await put({ path: '.env', content: CONTENT, totp: totp() });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      file: { path: '.env', keyNames: ['DB_HOST', 'API_KEY'], readable: true },
    });
    const firstUpdate = created.json<{ file: { updatedAt: number } }>().file.updatedAt;

    const replaced = await put({ path: '.env', content: `ONLY=${SENTINEL}\n`, totp: totp() });
    expect(replaced.statusCode).toBe(200);
    expect(rows()).toHaveLength(1);

    const backend = await put({ path: 'backend/.env', content: 'B=1\n', totp: totp() });
    expect(backend.statusCode).toBe(201);

    const listed = await list();
    expect(listed.statusCode).toBe(200);
    const files = listed.json<{ path: string; keyNames: string[]; updatedAt: number }[]>();
    expect(files.map((f) => Object.keys(f).sort())).toEqual([
      ['keyNames', 'path', 'readable', 'updatedAt'],
      ['keyNames', 'path', 'readable', 'updatedAt'],
    ]);
    expect(files[0]).toMatchObject({ path: '.env', keyNames: ['ONLY'], readable: true });
    expect(files[0]?.updatedAt).toBeGreaterThan(firstUpdate);

    for (const res of [created, replaced, backend, listed]) {
      expect(res.body).not.toContain(SENTINEL);
    }
  });

  it.each([
    ['a production file', { path: '.env.production' }],
    ['a template', { path: '.env.example' }],
    ['a path outside the project', { path: '../.env' }],
    ['an absolute path', { path: '/abs/.env' }],
    ['a path with ..', { path: 'a/../.env' }],
    ['a path git does not ignore', { path: 'config/.env' }],
    ['more than 64 KB', { content: `A=${'x'.repeat(65536)}` }],
    ['NUL in the content', { content: 'A=1\0\n' }],
    ['an invalid line', { content: `A=1\n${SENTINEL}\n` }],
    ['an extra field', { repoPath: '/etc' }],
  ])('rejects %s with 400 and stores nothing', async (_label, override) => {
    const { put, totp, rows } = await setup();
    const res = await put({ path: '.env', content: CONTENT, totp: totp(), ...override });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBeTruthy();
    expect(res.body).not.toContain(SENTINEL);
    expect(rows()).toEqual([]);
  });

  it('accepts backend/.env, ignored by the clone', async () => {
    const { put, totp } = await setup();
    expect((await put({ path: 'backend/.env', content: CONTENT, totp: totp() })).statusCode).toBe(
      201,
    );
  });

  it('rejects PUT without totp, with a wrong one or a reused one (401 invalid_totp) and stores nothing', async () => {
    const { put, totp, rows } = await setup();
    const used = totp();
    expect((await put({ path: '.env', content: 'A=1\n', totp: used })).statusCode).toBe(201);
    const before = rows();

    for (const payload of [
      { path: '.env', content: CONTENT },
      { path: '.env', content: CONTENT, totp: '000000' },
      { path: '.env', content: CONTENT, totp: used },
      // TOTP is checked first: an invalid path does not reveal a 400.
      { path: '../.env', content: CONTENT, totp: '000000' },
    ]) {
      const res = await put(payload);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_totp' });
    }
    expect(rows()).toEqual(before);
  });

  it('rejects DELETE without totp, with a wrong one or a reused one and deletes nothing', async () => {
    const { put, del, totp, rows } = await setup();
    const used = totp();
    await put({ path: '.env', content: 'A=1\n', totp: used });

    for (const payload of [
      { path: '.env' },
      { path: '.env', totp: '000000' },
      { path: '.env', totp: used },
    ]) {
      const res = await del(payload);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_totp' });
    }
    expect(rows()).toHaveLength(1);
  });

  it('deletes an existing path and answers 404 for a missing one', async () => {
    const { put, del, list, totp } = await setup();
    await put({ path: '.env', content: 'A=1\n', totp: totp() });
    await put({ path: 'backend/.env', content: 'B=1\n', totp: totp() });

    const removed = await del({ path: 'backend/.env', totp: totp() });
    expect(removed.statusCode).toBe(200);
    expect((await list()).json()).toMatchObject([{ path: '.env' }]);
    expect((await del({ path: 'backend/.env', totp: totp() })).statusCode).toBe(404);
  });

  it('answers 409 for a project that is not ready and 404 for an unknown one', async () => {
    const { db, project, put, del, list, totp, rows } = await setup();
    db.prepare("UPDATE projects SET status = 'cloning' WHERE id = ?").run(project.id);
    expect((await put({ path: '.env', content: CONTENT, totp: totp() })).statusCode).toBe(409);
    expect(rows()).toEqual([]);

    expect((await put({ path: '.env', content: CONTENT, totp: totp() }, 999)).statusCode).toBe(404);
    expect((await del({ path: '.env', totp: totp() }, 999)).statusCode).toBe(404);
    expect((await list(999)).statusCode).toBe(404);
  });

  it('applyToActive writes into each active worktree and reports the ones it skips', async () => {
    const { put, totp, addChat } = await setup();
    const ready = addChat('ready');
    mkdirSync(join(ready.worktreePath, 'backend'));
    const missing = addChat('missing');
    const gone = addChat('gone');
    rmSync(gone.worktreePath, { recursive: true, force: true });

    const res = await put({
      path: 'backend/.env',
      content: CONTENT,
      totp: totp(),
      applyToActive: true,
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(SENTINEL);
    const body = res.json<{ file: { path: string }; applied: { chatId: number }[] }>();
    body.applied.sort((a, b) => a.chatId - b.chatId);
    expect(body.file.path).toBe('backend/.env');
    expect(body.applied).toEqual([
      { chatId: ready.id, worktreePath: ready.worktreePath, status: 'written', reason: null },
      {
        chatId: missing.id,
        worktreePath: missing.worktreePath,
        status: 'skipped',
        reason: 'falta la carpeta backend para backend/.env',
      },
    ]);
    const written = join(ready.worktreePath, 'backend', '.env');
    expect(readFileSync(written, 'utf8')).toBe(CONTENT);
    expect(lstatSync(written).mode & 0o777).toBe(0o600);
  });

  it('applyToActive skips a chat with a running agent and leaves its file untouched', async () => {
    const { put, totp, addChat, db } = await setup();
    const idle = addChat('idle-one');
    const running = addChat('running-one');
    await put({ path: '.env', content: 'OLD=1\n', totp: totp(), applyToActive: true });
    const file = join(running.worktreePath, '.env');
    const before = lstatSync(file);
    db.prepare("UPDATE chats SET status = 'running' WHERE id = ?").run(running.id);

    const res = await put({
      path: '.env',
      content: CONTENT,
      totp: totp(),
      applyToActive: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SENTINEL);
    const body = res.json<{
      applied: { chatId: number; status: string; reason: string | null }[];
    }>();
    body.applied.sort((a, b) => a.chatId - b.chatId);
    expect(body.applied).toEqual([
      expect.objectContaining({ chatId: idle.id, status: 'written', reason: null }),
      expect.objectContaining({
        chatId: running.id,
        status: 'skipped',
        reason: 'agente en curso: se aplica cuando termine o en el próximo chat',
      }),
    ]);
    expect(readFileSync(join(idle.worktreePath, '.env'), 'utf8')).toBe(CONTENT);
    expect(readFileSync(file, 'utf8')).toBe('OLD=1\n');
    expect(lstatSync(file).mtimeMs).toBe(before.mtimeMs);
  });

  it('replaces the file in active worktrees with the new content', async () => {
    const { put, totp, addChat } = await setup();
    const chat = addChat('rotate');
    await put({ path: '.env', content: 'OLD=1\n', totp: totp(), applyToActive: true });
    const res = await put({ path: '.env', content: 'NEW=1\n', totp: totp(), applyToActive: true });
    expect(res.statusCode).toBe(200);
    expect(readFileSync(join(chat.worktreePath, '.env'), 'utf8')).toBe('NEW=1\n');
  });

  it('leaves every worktree untouched without applyToActive', async () => {
    const { put, totp, addChat } = await setup();
    const chat = addChat('untouched');
    const res = await put({ path: '.env', content: 'A=1\n', totp: totp() });
    expect(res.statusCode).toBe(201);
    expect(res.json()).not.toHaveProperty('applied');
    expect(() => lstatSync(join(chat.worktreePath, '.env'))).toThrow();

    const off = await put({ path: '.env', content: 'A=2\n', totp: totp(), applyToActive: false });
    expect(off.json()).not.toHaveProperty('applied');
    expect(() => lstatSync(join(chat.worktreePath, '.env'))).toThrow();
  });

  it('answers 401 without a session on GET, PUT and DELETE', async () => {
    const { server, project } = await setup();
    const url = `/api/projects/${String(project.id)}/env`;
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      const res = await server.inject({
        method,
        url,
        headers: { origin: 'http://localhost:4200' },
      });
      expect(res.statusCode, method).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthorized' });
    }
  });
});
