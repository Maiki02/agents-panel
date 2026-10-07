import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { PanelDeployer } from '../src/maintenance/deployer.js';
import { KyroLock } from '../src/maintenance/lock.js';
import { MaintenanceRunRepository } from '../src/maintenance/runs.js';
import { SwrCell } from '../src/maintenance/swr.js';
import { KyroUpdater } from '../src/maintenance/updater.js';
import { KyroVersions, type Exec } from '../src/maintenance/versions.js';

const SLOW_MS = 400;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** An exec that takes SLOW_MS, like a `git fetch` or `npm view` on a bad network. */
function slowExec(answer: (file: string) => string): ReturnType<typeof vi.fn<Exec>> {
  return vi.fn<Exec>(async (file) => {
    await sleep(SLOW_MS);
    return answer(file);
  });
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await run();
  return { value, ms: performance.now() - start };
}

describe('SwrCell', () => {
  it('answers a previous value at once and refreshes in the background only once per TTL', async () => {
    let t = 0;
    let n = 0;
    const load = vi.fn(async () => {
      await sleep(50);
      return (n += 1);
    });
    const cell = new SwrCell(load, 1_000, () => t);
    expect(await cell.get()).toBe(1);
    t = 2_000;
    // Stale: three reads in the same instant get the old value and start ONE refresh.
    expect(await Promise.all([cell.get(), cell.get(), cell.get()])).toEqual([1, 1, 1]);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => {
      expect(await cell.get()).toBe(2);
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares the first load between concurrent callers and keeps the old value when a refresh fails', async () => {
    let t = 0;
    const load = vi.fn<() => Promise<number>>().mockResolvedValueOnce(7);
    const cell = new SwrCell(load, 10, () => t);
    expect(await cell.get()).toBe(7);
    t = 100;
    load.mockRejectedValueOnce(new Error('offline'));
    expect(await cell.get()).toBe(7);
    await sleep(5);
    expect(await cell.get()).toBe(7);
  });

  it('does not store the result of a load that was invalidated while running', async () => {
    let n = 0;
    const cell = new SwrCell(async () => {
      await sleep(20);
      return (n += 1);
    }, 60_000);
    const first = cell.get();
    cell.invalidate();
    await first;
    expect(await cell.get()).toBe(2);
  });
});

describe('KyroVersions (stale-while-revalidate)', () => {
  it('answers /versions without waiting for npm view once it has a previous value', async () => {
    let t = 0;
    const exec = slowExec((file) => (file === 'kyro' ? '6.1.0\n' : '6.2.0\n'));
    const versions = new KyroVersions(exec, () => t);

    const first = await timed(() => versions.info());
    expect(first.value).toEqual({ installed: '6.1.0', latest: '6.2.0' });
    expect(first.ms).toBeGreaterThanOrEqual(SLOW_MS - 50);

    t = 61_000; // the TTL of latest passed
    const second = await timed(() => versions.info());
    expect(second.value).toEqual({ installed: '6.1.0', latest: '6.2.0' });
    expect(second.ms).toBeLessThan(SLOW_MS / 4);
    // Reported in the evidence: first load vs. stale load.
    console.log(
      `versions.info(): first ${first.ms.toFixed(0)} ms, stale ${second.ms.toFixed(0)} ms`,
    );

    // Many loads inside the same expired window start a single `npm view`.
    await Promise.all([versions.latest(), versions.latest(), versions.latest()]);
    const npmCalls = () => exec.mock.calls.filter(([file]) => file === 'npm').length;
    await vi.waitFor(() => {
      expect(npmCalls()).toBe(2);
    });
  });

  it('does not spawn kyro --version on every load', async () => {
    const exec = slowExec(() => '6.1.0\n');
    const versions = new KyroVersions(exec);
    await versions.installed();
    await versions.installed();
    await versions.installed();
    expect(exec.mock.calls.filter(([file]) => file === 'kyro')).toHaveLength(1);
  });

  it('warm() loads without blocking', async () => {
    const exec = slowExec((file) => (file === 'kyro' ? '6.1.0\n' : '6.2.0\n'));
    const versions = new KyroVersions(exec);
    const warm = await timed(() => {
      versions.warm();
      return Promise.resolve();
    });
    expect(warm.ms).toBeLessThan(SLOW_MS / 4);
    await vi.waitFor(() => {
      expect(exec).toHaveBeenCalledTimes(2);
    });
    const after = await timed(() => versions.info());
    expect(after.value).toEqual({ installed: '6.1.0', latest: '6.2.0' });
  });

  it('a finished Kyro update makes the next load see the new version', async () => {
    let installed = '6.1.0';
    const exec = vi.fn<Exec>((file) =>
      Promise.resolve(file === 'kyro' ? `${installed}\n` : '6.2.0\n'),
    );
    const versions = new KyroVersions(exec);
    const db = openDatabase(':memory:');
    const runs = new MaintenanceRunRepository(db);
    const onFinished = vi.fn();
    const updater = new KyroUpdater({
      manager: {
        tryBeginMaintenance: () => ({ ok: true }) as never,
        endMaintenance: () => undefined,
      },
      runs,
      versions,
      projects: { list: () => [] },
      lock: new KyroLock(),
      scriptPath: '/x/08-kyro-update.sh',
      runner: () => {
        installed = '6.2.0';
        return Promise.resolve({ exitCode: 0, output: 'ok' });
      },
      onFinished,
    });
    expect(await versions.installed()).toBe('6.1.0');
    await updater.start();
    await updater.whenIdle();
    expect(await versions.installed()).toBe('6.2.0');
    expect(runs.list()[0]?.toVersion).toBe('6.2.0');
    expect(onFinished).toHaveBeenCalledTimes(1);
    const kyroCalls = exec.mock.calls.filter(([file]) => file === 'kyro').length;
    await versions.installed();
    expect(exec.mock.calls.filter(([file]) => file === 'kyro')).toHaveLength(kyroCalls);
  });
});

describe('PanelDeployer.info (stale-while-revalidate)', () => {
  it('answers behind at once with a previous value and fetches once per TTL in the background', async () => {
    let t = 0;
    const exec = vi.fn<Exec>(async (_file, args) => {
      if (args.includes('rev-parse')) return 'abc1234\n';
      if (args.includes('fetch')) {
        await sleep(SLOW_MS);
        return '';
      }
      return '3\n';
    });
    const deployer = new PanelDeployer({
      manager: {
        tryBeginMaintenance: () => ({ ok: true }) as never,
        endMaintenance: () => undefined,
      },
      runs: new MaintenanceRunRepository(openDatabase(':memory:')),
      pilots: { listByStatus: () => [] },
      repoPath: '/repo',
      scriptPath: '/x.sh',
      selfDeploy: true,
      restart: () => undefined,
      exec,
      now: () => t,
    });
    await deployer.init(); // warms in the background
    const fetches = () => exec.mock.calls.filter(([, args]) => args.includes('fetch')).length;
    const first = await timed(() => deployer.info());
    expect(first.value.behind).toBe(3);
    expect(fetches()).toBe(1); // the warm-up fetch was shared, not repeated

    t = 61_000;
    const stale = await timed(() => deployer.info());
    expect(stale.value.behind).toBe(3);
    expect(stale.ms).toBeLessThan(SLOW_MS / 4);
    await Promise.all([deployer.info(), deployer.info()]);
    await vi.waitFor(() => {
      expect(fetches()).toBe(2);
    });
    console.log(
      `deployer.info(): first ${first.ms.toFixed(0)} ms, stale ${stale.ms.toFixed(0)} ms`,
    );
  });
});
