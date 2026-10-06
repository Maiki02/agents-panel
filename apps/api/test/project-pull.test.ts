import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { PullRejectedError, pullFastForward } from '../src/projects/git.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { ORIGIN, PASSWORD, makeApp, makeGitRepo, mutatingHeaders } from './helpers.js';

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...IDENTITY, ...args], { encoding: 'utf8' }).trim();

/** An origin (bare), the base clone the panel manages, and a second clone to push from. */
function makeRemote() {
  const seed = makeGitRepo();
  const root = mkdtempSync(join(tmpdir(), 'panel-pull-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', seed, origin]);
  const clone = join(root, 'clone');
  const pusher = join(root, 'pusher');
  execFileSync('git', ['clone', '-q', origin, clone]);
  execFileSync('git', ['clone', '-q', origin, pusher]);
  const pushCommit = (file: string, body = 'x\n') => {
    writeFileSync(join(pusher, file), body);
    git(pusher, 'add', file);
    git(pusher, 'commit', '-q', '-m', `add ${file}`);
    git(pusher, 'push', '-q', 'origin', 'main');
  };
  return { origin, clone, pusher, pushCommit };
}

describe('pullFastForward', () => {
  it('fast-forwards the clone and reports how many commits came', async () => {
    const { clone, pushCommit } = makeRemote();
    pushCommit('a.txt');
    pushCommit('b.txt');
    const before = git(clone, 'rev-parse', 'HEAD');
    const result = await pullFastForward(clone, 'main');
    expect(result).toMatchObject({ status: 'updated', before, commits: 2, ahead: 0 });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(result.after);
    expect(git(clone, 'ls-files')).toContain('b.txt');
  });

  it('says it is up to date when there is nothing new', async () => {
    const { clone } = makeRemote();
    const result = await pullFastForward(clone, 'main');
    expect(result).toMatchObject({ status: 'up_to_date', commits: 0, ahead: 0 });
    expect(result.before).toBe(result.after);
  });

  it('keeps local commits that origin does not have and reports them as ahead', async () => {
    const { clone } = makeRemote();
    writeFileSync(join(clone, 'local.txt'), 'l\n');
    git(clone, 'add', 'local.txt');
    git(clone, 'commit', '-q', '-m', 'local');
    const head = git(clone, 'rev-parse', 'HEAD');
    const result = await pullFastForward(clone, 'main');
    expect(result).toMatchObject({ status: 'up_to_date', ahead: 1 });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('refuses with local changes in tracked files and leaves the clone as it was', async () => {
    const { clone, pushCommit } = makeRemote();
    pushCommit('a.txt');
    writeFileSync(join(clone, 'README.md'), 'edited\n');
    const head = git(clone, 'rev-parse', 'HEAD');
    await expect(pullFastForward(clone, 'main')).rejects.toThrow(/cambios locales/);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(clone, 'status', '--porcelain')).toBe('M README.md');
  });

  it('does not treat untracked files as local changes', async () => {
    const { clone, pushCommit } = makeRemote();
    pushCommit('a.txt');
    writeFileSync(join(clone, 'scratch.txt'), 'tmp\n');
    expect((await pullFastForward(clone, 'main')).status).toBe('updated');
  });

  it('does not treat changes inside .agents/kyro/ as local changes (a Kyro update rewrites them)', async () => {
    const { clone, pusher, pushCommit } = makeRemote();
    mkdirSync(join(pusher, '.agents', 'kyro'), { recursive: true });
    writeFileSync(join(pusher, '.agents', 'kyro', 'project.json'), '{"v":1}\n');
    git(pusher, 'add', '.');
    git(pusher, 'commit', '-q', '-m', 'kyro');
    git(pusher, 'push', '-q', 'origin', 'main');
    await pullFastForward(clone, 'main');
    writeFileSync(join(clone, '.agents', 'kyro', 'project.json'), '{"v":2}\n');
    pushCommit('a.txt');
    expect((await pullFastForward(clone, 'main')).status).toBe('updated');
    expect(git(clone, 'status', '--porcelain')).toBe('M .agents/kyro/project.json');
    // Outside .agents/kyro/ it still refuses.
    writeFileSync(join(clone, 'README.md'), 'edited\n');
    pushCommit('b.txt');
    await expect(pullFastForward(clone, 'main')).rejects.toThrow(/cambios locales/);
  });

  it('refuses when the clone and origin diverged, touching nothing', async () => {
    const { clone, pushCommit } = makeRemote();
    pushCommit('remote.txt');
    writeFileSync(join(clone, 'local.txt'), 'l\n');
    git(clone, 'add', 'local.txt');
    git(clone, 'commit', '-q', '-m', 'local');
    const head = git(clone, 'rev-parse', 'HEAD');
    await expect(pullFastForward(clone, 'main')).rejects.toThrow(/divergieron/);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('refuses when the clone is on another branch than the base', async () => {
    const { clone } = makeRemote();
    git(clone, 'checkout', '-q', '-b', 'other');
    await expect(pullFastForward(clone, 'main')).rejects.toBeInstanceOf(PullRejectedError);
  });

  it('refuses a base branch that looks like an option', async () => {
    const { clone } = makeRemote();
    await expect(pullFastForward(clone, '--upload-pack=x')).rejects.toBeInstanceOf(
      PullRejectedError,
    );
  });
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
});

describe('POST /api/projects/:id/pull', () => {
  async function setup() {
    const made = makeApp();
    app = made.app;
    await app.ready();
    const server = app;
    const user = await new UserRepository(made.db).create('alice', PASSWORD);
    const { token, csrfToken } = new SessionService(made.db, {
      idleTtlSeconds: 1800,
      absoluteTtlSeconds: 43200,
    }).create(user.id);
    const headers = mutatingHeaders(`${SESSION_COOKIE}=${token}`, csrfToken);
    const remote = makeRemote();
    const project = await new ProjectRepository(made.db).add({
      name: 'demo',
      repoPath: remote.clone,
      baseBranch: 'main',
    });
    const pull = (id: number) =>
      server.inject({ method: 'POST', url: `/api/projects/${String(id)}/pull`, headers });
    return { ...made, ...remote, project, pull, server };
  }

  it('brings the new commits and answers the result', async () => {
    const { project, pull, pushCommit } = await setup();
    pushCommit('a.txt');
    const res = await pull(project.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'updated', commits: 1 });
    expect((await pull(project.id)).json()).toMatchObject({ status: 'up_to_date' });
  });

  it('answers 409 with local changes and does not modify the clone', async () => {
    const { project, pull, pushCommit, clone } = await setup();
    pushCommit('a.txt');
    writeFileSync(join(clone, 'README.md'), 'edited\n');
    const head = git(clone, 'rev-parse', 'HEAD');
    const res = await pull(project.id);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toContain('cambios locales');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('answers 409 for a project that is not ready, 404 for an unknown one, 401 without session', async () => {
    const { project, pull, db, server } = await setup();
    db.prepare("UPDATE projects SET status = 'cloning' WHERE id = ?").run(project.id);
    expect((await pull(project.id)).statusCode).toBe(409);
    expect((await pull(9999)).statusCode).toBe(404);
    const anonymous = await server.inject({ method: 'POST', url: '/api/projects/1/pull' });
    expect(anonymous.statusCode).toBeGreaterThanOrEqual(401);
  });

  it('answers 502 when origin cannot be reached', async () => {
    const { project, pull, origin } = await setup();
    execFileSync('git', ['-C', project.repoPath, 'remote', 'set-url', 'origin', origin + '-gone']);
    const res = await pull(project.id);
    expect(res.statusCode).toBe(502);
  });
});

describe('pull and repos routes with a child repo on another base', () => {
  /** Root on main (origin A) with an ignored child `be` on dev (origin B). */
  async function setupWorkspace() {
    const made = makeApp();
    app = made.app;
    await app.ready();
    const user = await new UserRepository(made.db).create('alice', PASSWORD);
    const { token, csrfToken } = new SessionService(made.db, {
      idleTtlSeconds: 1800,
      absoluteTtlSeconds: 43200,
    }).create(user.id);
    const headers = mutatingHeaders(`${SESSION_COOKIE}=${token}`, csrfToken);
    const remote = makeRemote();
    const childRoot = mkdtempSync(join(tmpdir(), 'panel-child-'));
    const childSeed = join(childRoot, 'seed');
    execFileSync('git', ['init', '-q', '-b', 'dev', childSeed]);
    writeFileSync(join(childSeed, 'c.txt'), 'c\n');
    git(childSeed, 'add', '.');
    git(childSeed, 'commit', '-q', '-m', 'seed');
    const childOrigin = join(childRoot, 'origin.git');
    execFileSync('git', ['clone', '-q', '--bare', childSeed, childOrigin]);
    const childClone = join(remote.clone, 'be');
    execFileSync('git', ['clone', '-q', childOrigin, childClone]);
    writeFileSync(join(remote.clone, '.git', 'info', 'exclude'), 'be/\n');
    const pushChild = (file: string) => {
      writeFileSync(join(childSeed, file), 'x\n');
      git(childSeed, 'add', file);
      git(childSeed, 'commit', '-q', '-m', `add ${file}`);
      git(childSeed, 'push', '-q', childOrigin, 'dev');
    };
    const project = await new ProjectRepository(made.db).add({
      name: 'ws',
      repoPath: remote.clone,
      baseBranch: 'main',
    });
    const server = app;
    const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
      server.inject({
        method,
        url,
        headers: method === 'GET' ? { cookie: headers['cookie'] ?? '' } : headers,
        ...(payload ? { payload } : {}),
      });
    const detect = () => call('POST', `/api/projects/${String(project.id)}/repos/detect`);
    const pull = () => call('POST', `/api/projects/${String(project.id)}/pull`);
    return { ...made, ...remote, project, childClone, pushChild, call, detect, pull, headers };
  }

  interface RepoRow {
    id: number;
    path: string;
    baseBranch: string;
  }

  function second(rows: RepoRow[]): RepoRow {
    const row = rows[1];
    if (!row) throw new Error('expected a second repo');
    return row;
  }

  it('detects the repos and pulls each one from its own base, one result per repo', async () => {
    const { detect, pull, call, project, pushChild, pushCommit, clone, childClone } =
      await setupWorkspace();
    const detected = await detect();
    expect(detected.statusCode).toBe(200);
    const rows = detected.json<RepoRow[]>();
    expect(rows.map((r) => [r.path, r.baseBranch])).toEqual([
      ['.', 'main'],
      ['be', 'main'],
    ]);
    const child = second(rows);
    const patched = await call(
      'PATCH',
      `/api/projects/${String(project.id)}/repos/${String(child.id)}`,
      {
        baseBranch: 'dev',
      },
    );
    expect(patched.statusCode).toBe(200);
    expect(
      (await call('GET', `/api/projects/${String(project.id)}/repos`)).json<RepoRow[]>()[1],
    ).toMatchObject({ path: 'be', baseBranch: 'dev' });

    pushCommit('root.txt');
    pushChild('child.txt');
    const res = await pull();
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      status: string;
      commits: number;
      repos: {
        path: string;
        baseBranch: string;
        result: { commits: number } | null;
        error: string | null;
      }[];
    }>();
    expect(body).toMatchObject({ status: 'updated', commits: 1 });
    expect(body.repos.map((r) => [r.path, r.baseBranch, r.result?.commits, r.error])).toEqual([
      ['.', 'main', 1, null],
      ['be', 'dev', 1, null],
    ]);
    expect(git(clone, 'ls-files')).toContain('root.txt');
    expect(git(childClone, 'ls-files')).toContain('child.txt');
  });

  it('rejects a child with local changes without stopping the root', async () => {
    const { detect, pull, call, project, pushChild, pushCommit, clone, childClone } =
      await setupWorkspace();
    const child = second((await detect()).json<RepoRow[]>());
    await call('PATCH', `/api/projects/${String(project.id)}/repos/${String(child.id)}`, {
      baseBranch: 'dev',
    });
    pushCommit('root.txt');
    pushChild('child.txt');
    writeFileSync(join(childClone, 'c.txt'), 'edited\n');
    const res = await pull();
    expect(res.statusCode).toBe(200);
    const body = res.json<{ repos: { path: string; result: unknown; error: string | null }[] }>();
    const be = body.repos.find((r) => r.path === 'be');
    expect(be?.result).toBeNull();
    expect(be?.error).toContain('cambios locales');
    expect(body.repos.find((r) => r.path === '.')?.error).toBeNull();
    expect(git(clone, 'ls-files')).toContain('root.txt');
    expect(git(childClone, 'ls-files')).not.toContain('child.txt');
  });

  it('answers 401 without session and 403 without CSRF on the new routes, running nothing', async () => {
    const { project, detect, db, headers, app: server } = await setupWorkspace();
    const base = `/api/projects/${String(project.id)}`;
    const routes = [
      { method: 'GET', url: `${base}/repos` },
      { method: 'POST', url: `${base}/repos/detect` },
      { method: 'PATCH', url: `${base}/repos/1`, payload: { baseBranch: 'dev' } },
      { method: 'POST', url: `${base}/pull` },
    ] as const;
    for (const route of routes) {
      const anonymous = await server.inject({ ...route, headers: { origin: ORIGIN } });
      expect(anonymous.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
    // Nothing was detected by the rejected calls.
    expect(db.prepare('SELECT count(*) AS n FROM project_repos').get()).toEqual({ n: 0 });
    await detect();
    for (const route of routes.filter((r) => r.method !== 'GET')) {
      const noCsrf = await server.inject({
        ...route,
        headers: { cookie: headers['cookie'] ?? '', origin: ORIGIN },
      });
      expect(noCsrf.statusCode, `${route.method} ${route.url}`).toBe(403);
    }
  });

  it('reports a missing child folder as that repo error', async () => {
    const { detect, pull, childClone } = await setupWorkspace();
    await detect();
    rmSync(childClone, { recursive: true, force: true });
    const body = (await pull()).json<{ repos: { path: string; error: string | null }[] }>();
    expect(body.repos.find((r) => r.path === 'be')?.error).toContain('Falta la carpeta');
    expect(body.repos.find((r) => r.path === '.')?.error).toBeNull();
  });

  it('PATCH answers 400 for a bad base, 404 for another project repo, and keeps a valid one', async () => {
    const { detect, call, project, db } = await setupWorkspace();
    const rows = (await detect()).json<RepoRow[]>();
    const child = second(rows);
    const url = `/api/projects/${String(project.id)}/repos/${String(child.id)}`;
    expect((await call('PATCH', url, { baseBranch: '--upload-pack=x' })).statusCode).toBe(400);
    expect((await call('PATCH', url, { baseBranch: 'a..b' })).statusCode).toBe(400);
    expect((await call('PATCH', url, { baseBranch: '' })).statusCode).toBe(400);
    expect((await call('PATCH', url, { baseBranch: 'dev', extra: 1 })).statusCode).toBe(400);
    const other = await new ProjectRepository(db).add({
      name: 'other',
      repoPath: makeRemote().clone,
      baseBranch: 'main',
    });
    const foreign = `/api/projects/${String(other.id)}/repos/${String(child.id)}`;
    expect((await call('PATCH', foreign, { baseBranch: 'dev' })).statusCode).toBe(404);
    expect(
      (await call('PATCH', `/api/projects/${String(project.id)}/repos/9999`, { baseBranch: 'dev' }))
        .statusCode,
    ).toBe(404);
    expect((await call('GET', '/api/projects/9999/repos')).statusCode).toBe(404);
    expect((await call('PATCH', url, { baseBranch: 'dev' })).statusCode).toBe(200);
    expect(
      (await call('GET', `/api/projects/${String(project.id)}/repos`)).json<RepoRow[]>()[1]
        ?.baseBranch,
    ).toBe('dev');
  });
});

describe('kyroPendingCommit in the project API', () => {
  it("is true only when Kyro's project.json is modified in the clone, and false once committed", async () => {
    const made = makeApp();
    app = made.app;
    await app.ready();
    const server = app;
    const user = await new UserRepository(made.db).create('alice', PASSWORD);
    const { token } = new SessionService(made.db, {
      idleTtlSeconds: 1800,
      absoluteTtlSeconds: 43200,
    }).create(user.id);
    const headers = { cookie: `${SESSION_COOKIE}=${token}` };
    const { clone } = makeRemote();
    mkdirSync(join(clone, '.agents', 'kyro'), { recursive: true });
    writeFileSync(join(clone, '.agents', 'kyro', 'project.json'), '{"v":1}\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'kyro');
    const project = await new ProjectRepository(made.db).add({
      name: 'demo',
      repoPath: clone,
      baseBranch: 'main',
    });
    const pending = async () => {
      const detail = await server.inject({ url: `/api/projects/${String(project.id)}`, headers });
      const list = await server.inject({ url: '/api/projects', headers });
      return [
        detail.json<{ kyroPendingCommit?: boolean }>().kyroPendingCommit,
        list.json<{ kyroPendingCommit?: boolean }[]>()[0]?.kyroPendingCommit,
      ];
    };
    expect(await pending()).toEqual([false, false]);
    writeFileSync(join(clone, '.agents', 'kyro', 'project.json'), '{"v":2}\n');
    expect(await pending()).toEqual([true, true]);
    git(clone, 'commit', '-q', '-am', 'kyro update');
    expect(await pending()).toEqual([false, false]);
  });

  it('is absent for a project without Kyro', async () => {
    const made = makeApp();
    app = made.app;
    await app.ready();
    const user = await new UserRepository(made.db).create('alice', PASSWORD);
    const { token } = new SessionService(made.db, {
      idleTtlSeconds: 1800,
      absoluteTtlSeconds: 43200,
    }).create(user.id);
    await new ProjectRepository(made.db).add({
      name: 'plain',
      repoPath: makeRemote().clone,
      baseBranch: 'main',
    });
    const list = await app.inject({
      url: '/api/projects',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(list.json<Record<string, unknown>[]>()[0]).not.toHaveProperty('kyroPendingCommit');
  });
});
