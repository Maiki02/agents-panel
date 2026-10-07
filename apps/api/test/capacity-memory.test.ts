import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryUsage } from '@agents-panel/shared';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { readMemory } from '../src/capacity/memory.js';
import { PASSWORD, makeApp } from './helpers.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'proc', 'meminfo');
const KB = 1024;
const dirs: string[] = [];
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'panel-mem-'));
  dirs.push(dir);
  return dir;
}

/** A simulated /proc with the fixture meminfo. cwd null means the cwd link is unreadable. */
function fakeProc(procs: { pid: number; ppid: number; rssKb: number; cwd: string | null }[]) {
  const root = tmp();
  copyFileSync(FIXTURE, join(root, 'meminfo'));
  for (const p of procs) {
    mkdirSync(join(root, String(p.pid)));
    writeFileSync(
      join(root, String(p.pid), 'status'),
      `Name:\tx\nPid:\t${String(p.pid)}\nPPid:\t${String(p.ppid)}\nVmRSS:\t${String(p.rssKb)} kB\n`,
    );
    if (p.cwd !== null) symlinkSync(p.cwd, join(root, String(p.pid), 'cwd'));
  }
  return root;
}

const WT = '/srv/worktrees';

describe('readMemory', () => {
  it('attributes AI/builds, the panel tree and the rest, and the sum closes on MemTotal', () => {
    const procRoot = fakeProc([
      { pid: 1, ppid: 0, rssKb: 100_000, cwd: '/' },
      { pid: 100, ppid: 1, rssKb: 300_000, cwd: '/srv/panel' }, // the API
      { pid: 101, ppid: 100, rssKb: 50_000, cwd: '/srv/panel' }, // child outside worktrees
      { pid: 102, ppid: 100, rssKb: 700_000, cwd: WT + '/proj/work' }, // session in a worktree
      { pid: 103, ppid: 102, rssKb: 200_000, cwd: WT + '/proj/work/apps' }, // its build
      { pid: 104, ppid: 1, rssKb: 90_000, cwd: '/srv/worktrees-other' }, // not under WT
      { pid: 105, ppid: 1, rssKb: 40_000, cwd: null }, // unreadable cwd
    ]);
    const { totals, swap } = readMemory({
      procRoot,
      worktreesDir: WT,
      panelPid: 100,
      now: () => 5,
    });
    expect(totals).not.toBeNull();
    if (!totals) return;
    expect(totals.aiBytes).toBe(900_000 * KB);
    expect(totals.panelBytes).toBe(350_000 * KB);
    expect(totals.availableBytes).toBe(8_000_000 * KB);
    expect(totals.totalBytes).toBe(12_000_000 * KB);
    // used = 4_000_000 kB; the rest (including the unreadable cwd) is Otros.
    expect(totals.otherBytes).toBe((4_000_000 - 900_000 - 350_000) * KB);
    expect(totals.aiBytes + totals.panelBytes + totals.otherBytes + totals.availableBytes).toBe(
      totals.totalBytes,
    );
    expect(swap).toEqual({ totalBytes: 2_000_000 * KB, usedBytes: 500_000 * KB });
  });

  it('an unreadable cwd does not break the read and is never AI nor Panel', () => {
    const procRoot = fakeProc([
      { pid: 100, ppid: 1, rssKb: 10, cwd: '/srv/panel' },
      { pid: 200, ppid: 1, rssKb: 999_000, cwd: null },
    ]);
    const { totals } = readMemory({ procRoot, worktreesDir: WT, panelPid: 100 });
    expect(totals?.aiBytes).toBe(0);
    expect(totals?.panelBytes).toBe(10 * KB);
    expect(totals?.otherBytes).toBe(4_000_000 * KB - 10 * KB);
  });

  it('keeps Otros at zero and the sum exact when RSS exceeds the used memory', () => {
    const procRoot = fakeProc([
      { pid: 100, ppid: 1, rssKb: 3_000_000, cwd: '/srv/panel' },
      { pid: 102, ppid: 100, rssKb: 3_000_000, cwd: WT + '/p/w' },
    ]);
    const { totals } = readMemory({ procRoot, worktreesDir: WT, panelPid: 100 });
    expect(totals).not.toBeNull();
    if (!totals) return;
    expect(totals.otherBytes).toBeGreaterThanOrEqual(0);
    expect(totals.aiBytes + totals.panelBytes + totals.otherBytes + totals.availableBytes).toBe(
      totals.totalBytes,
    );
  });

  it('returns no data (not zeros) and logs when meminfo cannot be read', () => {
    const logs: string[] = [];
    const usage = readMemory({
      procRoot: join(tmp(), 'missing'),
      worktreesDir: WT,
      log: (m) => logs.push(m),
      now: () => 9,
    });
    expect(usage).toEqual({ measuredAt: 9, totals: null, swap: null });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('meminfo');
  });

  it('returns no data when meminfo lacks a field', () => {
    const root = tmp();
    writeFileSync(join(root, 'meminfo'), 'MemTotal: 100 kB\n');
    const logs: string[] = [];
    const usage = readMemory({ procRoot: root, worktreesDir: WT, log: (m) => logs.push(m) });
    expect(usage.totals).toBeNull();
    expect(logs).toHaveLength(1);
  });
});

describe('GET /api/capacity/memory', () => {
  async function boot(procRoot: string) {
    const made = makeApp({}, undefined, { procRoot });
    app = made.app;
    await made.app.ready();
    const user = await new UserRepository(made.db).create('alice', PASSWORD);
    const { token } = new SessionService(made.db, {
      idleTtlSeconds: 1800,
      absoluteTtlSeconds: 43200,
    }).create(user.id);
    return { made, cookie: SESSION_COOKIE + '=' + token };
  }

  it('requires a session (401)', async () => {
    const { made } = await boot(fakeProc([]));
    const res = await made.app.inject({ method: 'GET', url: '/api/capacity/memory' });
    expect(res.statusCode).toBe(401);
  });

  it('is read on every request, with no cache', async () => {
    const procRoot = fakeProc([]);
    const { made, cookie } = await boot(procRoot);
    const get = async () =>
      (
        await made.app.inject({
          method: 'GET',
          url: '/api/capacity/memory',
          headers: { cookie },
        })
      ).json<MemoryUsage>();
    expect((await get()).swap?.usedBytes).toBe(500_000 * KB);
    writeFileSync(
      join(procRoot, 'meminfo'),
      'MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 100 kB\nSwapFree: 100 kB\n',
    );
    const second = await get();
    expect(second.totals?.totalBytes).toBe(1000 * KB);
    expect(second.swap?.usedBytes).toBe(0);
  });

  it('answers without data when meminfo fails', async () => {
    const { made, cookie } = await boot(join(tmp(), 'missing'));
    const res = await made.app.inject({
      method: 'GET',
      url: '/api/capacity/memory',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<MemoryUsage>()).toMatchObject({ totals: null, swap: null });
  });
});
