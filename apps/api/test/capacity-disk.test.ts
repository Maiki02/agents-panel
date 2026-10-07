import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiskUsage } from '@agents-panel/shared';
import { openDatabase } from '../src/db/index.js';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { DiskMonitor, duMeter, notifyDiskChanged, type DiskMeter } from '../src/capacity/disk.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { createWorktree } from '../src/worktrees/create.js';
import { ORIGIN, PASSWORD, makeApp, makeGitRepo, mutatingHeaders } from './helpers.js';

const dirs: string[] = [];
const monitors: DiskMonitor[] = [];
let app: FastifyInstance | undefined;
afterEach(async () => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  await app?.close();
  app = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'panel-disk-'));
  dirs.push(dir);
  return dir;
}

const GB = 1024 ** 3;

/** A meter that answers from a table (path -> bytes) and fails for unknown ones with ENOENT. */
function tableMeter(table: Record<string, number | Error>): DiskMeter {
  return (path) => {
    const value = table[path];
    if (value === undefined) {
      return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    }
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  };
}

function monitorOf(
  meter: DiskMeter,
  opts: { free?: number; total?: number; logs?: string[] } = {},
) {
  const projectsDir = tmp();
  const worktreesDir = tmp();
  const monitor = new DiskMonitor({
    projects: () => [
      { name: 'alpha', repoPath: join(projectsDir, 'alpha') },
      { name: 'beta', repoPath: join(projectsDir, 'beta') },
    ],
    projectsDir,
    worktreesDir,
    meter,
    fsStats: () =>
      Promise.resolve({ totalBytes: opts.total ?? 100 * GB, freeBytes: opts.free ?? 40 * GB }),
    now: () => 1234,
    log: (message) => opts.logs?.push(message),
  });
  monitors.push(monitor);
  return { monitor, projectsDir, worktreesDir };
}

describe('DiskMonitor', () => {
  it('before the first measurement reports measuring, with no numbers', () => {
    const { monitor } = monitorOf(tableMeter({}));
    expect(monitor.get()).toEqual({
      measuring: true,
      measuredAt: null,
      totals: null,
      projects: [],
      strays: [],
    });
  });

  it('measures repository and worktrees per project, strays and the totals', async () => {
    const logs: string[] = [];
    const { projectsDir, worktreesDir } = monitorOf(tableMeter({}), { logs });
    mkdirSync(join(projectsDir, 'alpha'));
    mkdirSync(join(projectsDir, 'loose'));
    mkdirSync(join(worktreesDir, 'beta'));
    mkdirSync(join(worktreesDir, 'junk'));
    const table: Record<string, number | Error> = {
      [join(projectsDir, 'alpha')]: 10 * GB,
      [join(projectsDir, 'loose')]: 1 * GB,
      [join(worktreesDir, 'beta')]: 5 * GB,
      [join(worktreesDir, 'junk')]: 2 * GB,
      // beta's clone is unreadable; alpha has no worktrees folder (absent -> 0 measured)
      [join(projectsDir, 'beta')]: new Error('EACCES: denied'),
    };
    const m = new DiskMonitor({
      projects: () => [
        { name: 'alpha', repoPath: join(projectsDir, 'alpha') },
        { name: 'beta', repoPath: join(projectsDir, 'beta') },
      ],
      projectsDir,
      worktreesDir,
      meter: tableMeter(table),
      fsStats: () => Promise.resolve({ totalBytes: 100 * GB, freeBytes: 40 * GB }),
      now: () => 1234,
      log: (message) => logs.push(message),
    });
    monitors.push(m);

    expect(m.refresh()).toBe(true);
    expect(m.get().measuring).toBe(true);
    await m.whenIdle();
    const usage = m.get();
    expect(usage.measuring).toBe(false);
    expect(usage.measuredAt).toBe(1234);
    expect(usage.projects).toEqual([
      { name: 'alpha', repositoryBytes: 10 * GB, worktreesBytes: 0 },
      { name: 'beta', repositoryBytes: null, worktreesBytes: 5 * GB },
    ]);
    expect(usage.strays).toEqual([
      { name: 'loose', area: 'proyectos', bytes: 1 * GB },
      { name: 'junk', area: 'worktrees', bytes: 2 * GB },
    ]);
    expect(usage.totals).toEqual({
      totalBytes: 100 * GB,
      projectsBytes: 11 * GB,
      worktreesBytes: 7 * GB,
      otherBytes: 42 * GB,
      freeBytes: 40 * GB,
    });
    // The failure of beta's clone is logged (with its path) and only that item lacks data.
    expect(logs.some((line) => line.includes('beta') && line.includes('EACCES'))).toBe(true);
    expect(JSON.stringify(usage)).not.toContain(projectsDir);
  });

  it('keeps Otros at zero and the sum exact when the folders exceed the used space', async () => {
    const { monitor, projectsDir } = monitorOf(
      (path) => Promise.resolve(path.startsWith(projectsDir) ? 80 * GB : 30 * GB),
      { total: 100 * GB, free: 40 * GB },
    );
    await (async () => {
      monitor.refresh();
      await monitor.whenIdle();
    })();
    const totals = monitor.get().totals;
    expect(totals).not.toBeNull();
    if (!totals) return;
    expect(totals.otherBytes).toBe(0);
    expect(
      totals.projectsBytes + totals.worktreesBytes + totals.otherBytes + totals.freeBytes,
    ).toBe(totals.totalBytes);
  });

  it('runs one measurement at a time and answers while a slow meter is running', async () => {
    let release: (bytes: number) => void = () => undefined;
    let calls = 0;
    const { monitor } = monitorOf(() => {
      calls += 1;
      return new Promise<number>((resolve) => {
        release = resolve;
      });
    });
    expect(monitor.refresh()).toBe(true);
    expect(monitor.refresh()).toBe(false);
    expect(monitor.get().measuring).toBe(true); // GET does not wait for the meter
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(1);
    // Let every pending item finish.
    for (let i = 0; i < 20 && monitor.measuring; i++) {
      release(1);
      await new Promise((r) => setImmediate(r));
    }
    await monitor.whenIdle();
    expect(monitor.get().measuring).toBe(false);
  });

  it('measures again when a worktree or project changes, once more after the one in flight', async () => {
    let calls = 0;
    const { monitor } = monitorOf(() => {
      calls += 1;
      return Promise.resolve(1);
    });
    monitor.start();
    await monitor.whenIdle();
    const first = calls;
    notifyDiskChanged();
    await monitor.whenIdle();
    expect(calls).toBeGreaterThan(first);
    const second = calls;
    notifyDiskChanged();
    notifyDiskChanged(); // arrives while measuring: queues exactly one more run
    await monitor.whenIdle();
    expect(calls).toBeGreaterThanOrEqual(second * 2);
    monitor.stop();
    const stopped = calls;
    notifyDiskChanged();
    await monitor.whenIdle();
    expect(calls).toBe(stopped);
  });
});

describe('duMeter', () => {
  it('does not count what a symlink points to', async () => {
    const root = tmp();
    const big = join(root, 'big');
    mkdirSync(big);
    writeFileSync(join(big, 'blob'), Buffer.alloc(4 * 1024 * 1024, 1));
    const target = join(root, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'small'), 'x');
    symlinkSync(big, join(target, 'link'));
    const bigBytes = await duMeter(big);
    const targetBytes = await duMeter(target);
    expect(bigBytes).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    expect(targetBytes).toBeLessThan(1024 * 1024);
  });

  it('rejects an absent folder with ENOENT', async () => {
    await expect(duMeter(join(tmp(), 'nope'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('disk routes', () => {
  async function boot(meter: DiskMeter, seed?: (db: ReturnType<typeof openDatabase>) => void) {
    const made = makeApp({}, undefined, { diskMeter: meter });
    app = made.app;
    seed?.(made.db);
    await made.app.ready();
    const user = await new UserRepository(made.db).create('alice', PASSWORD);
    const { token, csrfToken } = new SessionService(made.db, {
      idleTtlSeconds: 1800,
      absoluteTtlSeconds: 43200,
    }).create(user.id);
    const cookie = `${SESSION_COOKIE}=${token}`;
    return { made, cookie, headers: mutatingHeaders(cookie, csrfToken) };
  }

  it('requires a session (401) and CSRF on the refresh (403)', async () => {
    const { made, cookie } = await boot(() => Promise.resolve(1));
    expect((await made.app.inject({ method: 'GET', url: '/api/capacity/disk' })).statusCode).toBe(
      401,
    );
    const noCsrf = await made.app.inject({
      method: 'POST',
      url: '/api/capacity/disk/refresh',
      headers: { cookie, origin: ORIGIN },
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('answers measuring with no numbers while the first measurement runs, then the result', async () => {
    let release: (bytes: number) => void = () => undefined;
    const projectPath = tmp();
    const { made, headers } = await boot(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
      (db) =>
        new ProjectRepository(db).insertGithub({
          name: 'gamma',
          displayName: null,
          repoUrl: 'https://github.com/acme/gamma',
          repoPath: projectPath,
          baseBranch: 'main',
          setupCommand: null,
          status: 'ready',
          statusDetail: null,
        }),
    );
    const slow = await made.app.inject({ method: 'GET', url: '/api/capacity/disk', headers });
    expect(slow.statusCode).toBe(200);
    const during = slow.json<DiskUsage>();
    expect(during).toMatchObject({ measuring: true, measuredAt: null, totals: null, projects: [] });

    const again = await made.app.inject({
      method: 'POST',
      url: '/api/capacity/disk/refresh',
      headers,
    });
    expect(again.json()).toEqual({ started: false, measuring: true });

    for (let i = 0; i < 20; i++) {
      release(7);
      await new Promise((r) => setImmediate(r));
    }
    for (let i = 0; i < 50; i++) {
      const res = await made.app.inject({ method: 'GET', url: '/api/capacity/disk', headers });
      const body = res.json<DiskUsage>();
      if (!body.measuring) {
        expect(body.measuredAt).not.toBeNull();
        expect(body.projects[0]).toEqual({
          name: 'gamma',
          repositoryBytes: 7,
          worktreesBytes: 7,
        });
        expect(res.body).not.toContain(projectPath);
        return;
      }
      release(7);
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('the measurement never finished');
  });

  it('creating a worktree triggers a new measurement', async () => {
    let calls = 0;
    const { made } = await boot(() => {
      calls += 1;
      return Promise.resolve(1);
    });
    const repo = makeGitRepo();
    const project = await new ProjectRepository(made.db).add({
      name: 'delta',
      repoPath: repo,
      baseBranch: 'main',
    });
    await new Promise((r) => setTimeout(r, 50));
    const before = calls;
    await createWorktree(project, 'one', made.worktreesDir);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBeGreaterThan(before);
  });
});
