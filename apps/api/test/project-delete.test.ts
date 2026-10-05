import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { SecondFactorRepository, generateTotpCode, generateTotpSecret } from '../src/auth/totp.js';
import { UserRepository } from '../src/auth/users.js';
import { ChatRepository } from '../src/chats/repo.js';
import { EnvFileRepository } from '../src/env-files/repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { createWorktree } from '../src/worktrees/create.js';
import { PASSWORD, TEST_ENV, makeApp, makeGitRepo, mutatingHeaders } from './helpers.js';

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...IDENTITY, ...args], { encoding: 'utf8' }).trim();

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
});

const PERIOD_MS = 30_000;

async function setup() {
  const state = { t: 1_700_000_000_000 };
  const made = makeApp({}, () => state.t);
  app = made.app;
  await app.ready();
  const server = app;
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
  const totp = () => {
    state.t += PERIOD_MS;
    return generateTotpCode(secret, state.t);
  };

  // A project laid out like a real one: bare origin, clone under projectsDir, worktrees under worktreesDir.
  const root = mkdtempSync(join(tmpdir(), 'panel-del-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', makeGitRepo(), origin]);
  const clone = join(made.projectsDir, 'demo');
  execFileSync('git', ['clone', '-q', origin, clone]);
  const projects = new ProjectRepository(made.db);
  const project = await projects.add({ name: 'demo', repoPath: clone, baseBranch: 'main' });
  const chats = new ChatRepository(made.db);
  const envFiles = new EnvFileRepository(made.db, Buffer.from(TEST_ENV.PANEL_SECRET_KEY));
  envFiles.upsert(project.id, '.env', 'SECRET=1\n', ['SECRET']);
  const addChat = async (slug: string, status: 'idle' | 'running' = 'idle') => {
    const wt = await createWorktree(project, slug, made.worktreesDir);
    const chat = chats.create({
      projectId: project.id,
      kind: 'direct',
      slug,
      title: slug,
      worktreePath: wt.path,
      branch: wt.branch,
      status,
    });
    chats.appendEvent(chat.id, 'x', {});
    return { chat, wt };
  };
  const del = (id: number, payload: Record<string, unknown>) =>
    server.inject({ method: 'DELETE', url: `/api/projects/${String(id)}`, headers, payload });
  const count = (table: string) =>
    Number(made.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.['n']);
  return { ...made, server, totp, project, clone, origin, addChat, del, count, projects, chats };
}

describe('DELETE /api/projects/:id', () => {
  it('removes worktrees, clone, chats, events, .env files and the registry row of a clean project', async () => {
    const { project, clone, addChat, del, totp, count, worktreesDir, projects } = await setup();
    const { wt } = await addChat('a');
    await addChat('b');
    const res = await del(project.id, { name: 'demo', code: totp() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cloneRemoved: true });
    expect(existsSync(clone)).toBe(false);
    expect(existsSync(wt.path)).toBe(false);
    expect(existsSync(join(worktreesDir, 'demo'))).toBe(false);
    expect(projects.findById(project.id)).toBeUndefined();
    for (const table of ['chats', 'chat_events', 'project_env_files']) expect(count(table)).toBe(0);
  });

  it('refuses with the blockers when a worktree has an unpushed commit, deleting nothing; works once pushed', async () => {
    const { project, clone, addChat, del, totp, count } = await setup();
    const { wt } = await addChat('a');
    writeFileSync(join(wt.path, 'work.txt'), 'w\n');
    git(wt.path, 'add', 'work.txt');
    git(wt.path, 'commit', '-q', '-m', 'work');
    const res = await del(project.id, { name: 'demo', code: totp() });
    expect(res.statusCode).toBe(409);
    const body = res.json<{ blockers: { kind: string; detail: string }[]; running: number }>();
    expect(body.blockers).toMatchObject([{ kind: 'unpushed' }]);
    expect(body.blockers[0]?.detail).toContain('feature/a');
    expect(existsSync(clone)).toBe(true);
    expect(existsSync(wt.path)).toBe(true);
    expect(count('chats')).toBe(1);
    expect(count('project_env_files')).toBe(1);

    git(wt.path, 'push', '-q', 'origin', 'feature/a');
    expect((await del(project.id, { name: 'demo', code: totp() })).statusCode).toBe(200);
    expect(existsSync(clone)).toBe(false);
  });

  it('refuses with uncommitted changes in a worktree', async () => {
    const { project, addChat, del, totp, clone } = await setup();
    const { wt } = await addChat('a');
    writeFileSync(join(wt.path, 'README.md'), 'edited\n');
    const res = await del(project.id, { name: 'demo', code: totp() });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ blockers: { kind: string }[] }>().blockers[0]?.kind).toBe('uncommitted');
    expect(existsSync(clone)).toBe(true);
  });

  it('refuses while a session is running', async () => {
    const { project, addChat, del, totp, clone } = await setup();
    await addChat('a', 'running');
    const res = await del(project.id, { name: 'demo', code: totp() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ running: 1 });
    expect(existsSync(clone)).toBe(true);
  });

  it('refuses a wrong name, a missing or invalid code, and unknown fields, deleting nothing', async () => {
    const { project, del, totp, clone, count } = await setup();
    expect((await del(project.id, { name: 'otro', code: totp() })).statusCode).toBe(400);
    expect((await del(project.id, { name: 'demo' })).statusCode).toBe(401);
    expect((await del(project.id, { name: 'demo', code: '000000' })).statusCode).toBe(401);
    expect((await del(project.id, { name: 'demo', code: totp(), extra: 1 })).statusCode).toBe(400);
    expect(existsSync(clone)).toBe(true);
    expect(count('project_env_files')).toBe(1);
  });

  it('answers 404 for an unknown project and 409 for one still cloning', async () => {
    const { project, del, totp, db } = await setup();
    expect((await del(9999, { name: 'demo', code: totp() })).statusCode).toBe(404);
    db.prepare("UPDATE projects SET status = 'cloning' WHERE id = ?").run(project.id);
    expect((await del(project.id, { name: 'demo', code: totp() })).statusCode).toBe(409);
  });

  it('accepts the display name as confirmation', async () => {
    const { project, del, totp, db } = await setup();
    db.prepare("UPDATE projects SET display_name = 'Mi Demo' WHERE id = ?").run(project.id);
    expect((await del(project.id, { name: 'Mi Demo', code: totp() })).statusCode).toBe(200);
  });

  it('never deletes a clone outside the projects directory: it unregisters it and keeps the folder', async () => {
    const { db, del, totp, worktreesDir, origin } = await setup();
    const outside = mkdtempSync(join(tmpdir(), 'panel-outside-'));
    const clone = join(outside, 'mine');
    execFileSync('git', ['clone', '-q', origin, clone]);
    const adopted = await new ProjectRepository(db).add({
      name: 'adopted',
      repoPath: clone,
      baseBranch: 'main',
    });
    const wt = await createWorktree(adopted, 'x', worktreesDir);
    const res = await del(adopted.id, { name: 'adopted', code: totp() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cloneRemoved: false });
    expect(existsSync(clone)).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
    expect(git(clone, 'worktree', 'list', '--porcelain')).not.toContain('worktrees');
    expect(git(clone, 'worktree', 'list')).not.toContain(wt.path);
  });

  it('does not follow a symlink as the clone folder', async () => {
    const { db, projectsDir, del, totp, origin } = await setup();
    const victim = join(mkdtempSync(join(tmpdir(), 'panel-victim-')), 'repo');
    execFileSync('git', ['clone', '-q', origin, victim]);
    writeFileSync(join(victim, '.git', 'keep.txt'), 'k\n');
    const link = join(projectsDir, 'link');
    symlinkSync(victim, link);
    const project = await new ProjectRepository(db).add({
      name: 'link',
      repoPath: link,
      baseBranch: 'main',
    });
    const res = await del(project.id, { name: 'link', code: totp() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cloneRemoved: false });
    expect(existsSync(join(victim, '.git', 'keep.txt'))).toBe(true);
  });

  it('refuses to delete a clone folder that is not a git repo, without touching it', async () => {
    const { project, clone, del, totp, projects } = await setup();
    execFileSync('rm', ['-rf', join(clone, '.git')]);
    writeFileSync(join(clone, 'precious.txt'), 'p\n');
    const res = await del(project.id, { name: 'demo', code: totp() });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ blockers: { detail: string }[] }>().blockers[0]?.detail).toContain(
      'sin .git',
    );
    expect(existsSync(join(clone, 'precious.txt'))).toBe(true);
    expect(projects.findById(project.id)).toBeDefined();
  });

  it('unregisters a project whose clone folder is already gone', async () => {
    const { project, clone, del, totp, projects } = await setup();
    execFileSync('rm', ['-rf', clone]);
    const res = await del(project.id, { name: 'demo', code: totp() });
    expect(res.statusCode).toBe(200);
    expect(projects.findById(project.id)).toBeUndefined();
  });

  it('answers 401 without a session', async () => {
    const { server, project } = await setup();
    const res = await server.inject({
      method: 'DELETE',
      url: `/api/projects/${String(project.id)}`,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(401);
  });

  it('keeps the project registered and retryable when the file removal fails halfway', async () => {
    const { project, del, totp, clone, projects } = await setup();
    // A read-only parent makes rm of the clone fail after the worktrees dir was handled.
    execFileSync('chmod', ['555', join(clone, '..')]);
    try {
      const res = await del(project.id, { name: 'demo', code: totp() });
      if (process.getuid?.() === 0) return; // root ignores permissions
      expect(res.statusCode).toBe(500);
      expect(res.json<{ error: string }>().error).toContain('reintentar');
      expect(projects.findById(project.id)).toBeDefined();
    } finally {
      execFileSync('chmod', ['755', join(clone, '..')]);
    }
    expect((await del(project.id, { name: 'demo', code: totp() })).statusCode).toBe(200);
  });
});
