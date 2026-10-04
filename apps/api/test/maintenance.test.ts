import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@agents-panel/shared';
import { AgentManager } from '../src/agent/manager.js';
import { ChatEventBus } from '../src/chats/events.js';
import { ChatRepository } from '../src/chats/repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { ProjectService } from '../src/projects/service.js';
import { KyroLock } from '../src/maintenance/lock.js';
import {
  KyroUpdater,
  UpdateBlockedError,
  bashRunner,
  type ScriptResult,
  type ScriptRunner,
} from '../src/maintenance/updater.js';
import { FakeRunner } from './fake-runner.js';
import { makeGitRepo } from './helpers.js';
import { openDatabase } from '../src/db/index.js';
import {
  MAX_OUTPUT_BYTES,
  MaintenanceRunRepository,
  TRUNCATION_MARK,
  trimOutput,
} from '../src/maintenance/runs.js';
import { KyroVersions, parseVersion, type Exec } from '../src/maintenance/versions.js';

describe('KyroVersions', () => {
  it('reads both versions through execFile argv with timeouts', async () => {
    const calls: [string, string[], number][] = [];
    const exec: Exec = (file, args, timeout) => {
      calls.push([file, args, timeout]);
      return Promise.resolve(file === 'kyro' ? '6.1.0\n' : '6.2.0\n');
    };
    expect(await new KyroVersions(exec).info()).toEqual({ installed: '6.1.0', latest: '6.2.0' });
    expect(calls).toContainEqual(['kyro', ['--version'], 5_000]);
    expect(calls).toContainEqual(['npm', ['view', 'kyro-ai', 'version'], 10_000]);
  });

  it.each([
    ['the executor fails', () => Promise.reject(new Error('ENOTFOUND'))],
    ['the timeout fires', () => Promise.reject(Object.assign(new Error('x'), { killed: true }))],
    ['the output is not a version', () => Promise.resolve('npm ERR! network\n')],
    ['the output is empty', () => Promise.resolve('')],
  ])('returns null when %s', async (_name, run) => {
    const versions = new KyroVersions(run);
    expect(await versions.installed()).toBeNull();
    expect(await versions.latest()).toBeNull();
  });

  it('caches latest for a minute, so repeated reads run npm once', async () => {
    let t = 0;
    const exec = vi.fn<Exec>(() => Promise.resolve('6.2.0\n'));
    const versions = new KyroVersions(exec, () => t);
    await versions.latest();
    await versions.latest();
    expect(exec).toHaveBeenCalledTimes(1);
    t = 61_000;
    await versions.latest();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('only accepts semver', () => {
    expect(parseVersion('6.1.0')).toBe('6.1.0');
    expect(parseVersion('6.2.0-beta.1\n')).toBe('6.2.0-beta.1');
    expect(parseVersion('v6.1.0')).toBeNull();
    expect(parseVersion('6.1')).toBeNull();
    expect(parseVersion('6.1.0; rm -rf /')).toBeNull();
  });
});

describe('MaintenanceRunRepository', () => {
  const make = () => {
    let t = 1000;
    const repo = new MaintenanceRunRepository(openDatabase(':memory:'), () => (t += 10));
    return repo;
  };

  it('creates running, finishes, and lists newest first', () => {
    const repo = make();
    const first = repo.create('6.0.2');
    expect(first).toMatchObject({
      kind: 'kyro-update',
      fromVersion: '6.0.2',
      toVersion: null,
      status: 'running',
      output: null,
      finishedAt: null,
    });
    repo.finish(first.id, { status: 'ok', toVersion: '6.1.0', output: 'listo' });
    const second = repo.create('6.1.0');
    repo.finish(second.id, { status: 'error', toVersion: '6.1.0', output: 'falló' });

    const runs = repo.list();
    expect(runs.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(runs[1]).toMatchObject({ status: 'ok', toVersion: '6.1.0', output: 'listo' });
    expect(runs[1]?.finishedAt).toBeGreaterThan(runs[1]?.startedAt ?? Infinity);
    expect(repo.list(1)).toHaveLength(1);
  });

  it('failInterrupted turns only running runs into errors', () => {
    const repo = make();
    const done = repo.create(null);
    repo.finish(done.id, { status: 'ok', toVersion: '6.1.0', output: 'ok' });
    const stuck = repo.create('6.1.0');
    expect(repo.failInterrupted()).toBe(1);
    expect(repo.findById(stuck.id)).toMatchObject({
      status: 'error',
      output: 'interrumpido',
    });
    expect(repo.findById(stuck.id)?.finishedAt).not.toBeNull();
    expect(repo.findById(done.id)?.output).toBe('ok');
    expect(repo.failInterrupted()).toBe(0);
  });

  it('keeps the last 16 KB of a longer output, with a mark', () => {
    const repo = make();
    const run = repo.create(null);
    const output = `${'a'.repeat(20_000)}FIN`;
    repo.finish(run.id, { status: 'ok', toVersion: '6.1.0', output });
    const saved = repo.findById(run.id)?.output ?? '';
    expect(saved.startsWith(TRUNCATION_MARK)).toBe(true);
    expect(saved.endsWith('FIN')).toBe(true);
    expect(Buffer.byteLength(saved.slice(TRUNCATION_MARK.length))).toBe(MAX_OUTPUT_BYTES);
  });

  it('does not touch short outputs and counts bytes, not characters', () => {
    expect(trimOutput('corto')).toBe('corto');
    const multibyte = 'ñ'.repeat(MAX_OUTPUT_BYTES); // 2 bytes each: twice the limit in bytes
    const trimmed = trimOutput(multibyte);
    expect(trimmed.startsWith(TRUNCATION_MARK)).toBe(true);
    expect(trimmed).not.toContain('�');
    expect(Buffer.byteLength(trimmed.slice(TRUNCATION_MARK.length))).toBeLessThanOrEqual(
      MAX_OUTPUT_BYTES,
    );
  });
});

const project = (name: string, over: Partial<Project> = {}): Project =>
  ({ name, repoPath: `/p/${name}`, status: 'ready', hasKyro: true, ...over }) as Project;

function updaterSetup(
  options: {
    runner?: ScriptRunner;
    installed?: () => Promise<string | null>;
    projects?: Project[];
    lock?: KyroLock;
  } = {},
) {
  const db = openDatabase(':memory:');
  const manager = new AgentManager(new ChatRepository(db), new FakeRunner(), new ChatEventBus());
  const runs = new MaintenanceRunRepository(db);
  const calls: string[][] = [];
  const runner: ScriptRunner =
    options.runner ??
    ((args) => {
      calls.push(args);
      return Promise.resolve({ exitCode: 0, output: 'listo\nKYRO_VERSION=9.9.9\n' });
    });
  const updater = new KyroUpdater({
    manager,
    runs,
    versions: { installed: options.installed ?? (() => Promise.resolve('6.1.0')) },
    projects: {
      list: () =>
        options.projects ?? [
          project('a'),
          project('no-kyro', { hasKyro: false }),
          project('cloning', { status: 'cloning' }),
          project('b'),
        ],
    },
    lock: options.lock ?? new KyroLock(),
    scriptPath: '/fake/08-kyro-update.sh',
    runner: (args, timeout) => {
      if (!options.runner) return runner(args, timeout);
      calls.push(args);
      return options.runner(args, timeout);
    },
  });
  return { updater, manager, runs, calls };
}

describe('KyroUpdater', () => {
  it('records an ok run with the measured version and passes only ready Kyro roots', async () => {
    let installed = '6.1.0';
    const { updater, runs, calls, manager } = updaterSetup({
      installed: () => Promise.resolve(installed),
      runner: () => {
        installed = '9.9.9';
        return Promise.resolve({ exitCode: 0, output: 'listo\nKYRO_VERSION=9.9.9\n' });
      },
    });
    const id = await updater.start();
    expect(runs.findById(id)).toMatchObject({ status: 'running', fromVersion: '6.1.0' });
    expect(manager.inMaintenance).toBe(true);
    await updater.whenIdle();
    expect(runs.findById(id)).toMatchObject({
      status: 'ok',
      fromVersion: '6.1.0',
      toVersion: '9.9.9',
    });
    expect(runs.findById(id)?.output).toContain('KYRO_VERSION=9.9.9');
    expect(calls).toEqual([['/fake/08-kyro-update.sh', '/p/a', '/p/b']]);
    expect(manager.inMaintenance).toBe(false);
  });

  it('records an error run with the trimmed output and the version really installed', async () => {
    const { updater, runs, manager } = updaterSetup({
      runner: () => Promise.resolve({ exitCode: 1, output: `${'x'.repeat(20_000)}boom` }),
    });
    const id = await updater.start();
    await updater.whenIdle();
    const run = runs.findById(id);
    expect(run).toMatchObject({ status: 'error', fromVersion: '6.1.0', toVersion: '6.1.0' });
    expect(run?.output?.startsWith(TRUNCATION_MARK)).toBe(true);
    expect(run?.output?.endsWith('boom')).toBe(true);
    expect(manager.inMaintenance).toBe(false);
  });

  it('falls back to the KYRO_VERSION line when kyro cannot be measured', async () => {
    let calls = 0;
    const { updater, runs } = updaterSetup({
      installed: () => Promise.resolve(++calls === 1 ? '6.1.0' : null),
    });
    const id = await updater.start();
    await updater.whenIdle();
    expect(runs.findById(id)?.toVersion).toBe('9.9.9');
  });

  it('frees the lock and records an error when the runner throws', async () => {
    const { updater, runs, manager } = updaterSetup({
      runner: () => Promise.reject(new Error('spawn failed')),
    });
    const id = await updater.start();
    await updater.whenIdle();
    expect(runs.findById(id)).toMatchObject({ status: 'error', output: 'spawn failed' });
    expect(manager.inMaintenance).toBe(false);
  });

  it('answers 409 with the session count and creates nothing when sessions are running', async () => {
    const db = openDatabase(':memory:');
    const runs = new MaintenanceRunRepository(db);
    const runner = vi.fn<ScriptRunner>();
    const updater = new KyroUpdater({
      manager: {
        tryBeginMaintenance: () => ({ ok: false, running: 2 }),
        endMaintenance: () => undefined,
      },
      runs,
      versions: { installed: () => Promise.resolve('6.1.0') },
      projects: { list: () => [] },
      lock: new KyroLock(),
      scriptPath: '/fake.sh',
      runner,
    });
    const error = await updater.start().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpdateBlockedError);
    expect(error).toMatchObject({ status: 409, running: 2 });
    expect((error as Error).message).toContain('2');
    expect(runs.list()).toHaveLength(0);
    expect(runner).not.toHaveBeenCalled();
  });

  it('still frees the lock when saving the result fails, without an unhandled rejection', async () => {
    const { updater, runs, manager } = updaterSetup();
    vi.spyOn(runs, 'finish').mockImplementation(() => {
      throw new Error('database is locked');
    });
    await updater.start();
    await expect(updater.whenIdle()).resolves.toBeUndefined();
    expect(manager.inMaintenance).toBe(false);
  });

  it('refuses a second start while the first runs, and works again afterwards', async () => {
    let finish: (r: ScriptResult) => void = () => undefined;
    const { updater, runs, calls } = updaterSetup({
      runner: () =>
        new Promise<ScriptResult>((resolve) => {
          finish = resolve;
        }),
    });
    await updater.start();
    await expect(updater.start()).rejects.toMatchObject({ status: 409, running: null });
    expect(runs.list()).toHaveLength(1);
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    finish({ exitCode: 0, output: 'ok' });
    await updater.whenIdle();
    await updater.start();
    await vi.waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    finish({ exitCode: 1, output: 'mal' });
    await updater.whenIdle();
    expect(runs.list().map((r) => r.status)).toEqual(['error', 'ok']);
    await updater.start();
    finish({ exitCode: 0, output: 'ok' });
    await updater.whenIdle();
  });
});

describe('KyroLock (debt-4)', () => {
  it('runs holders one at a time, in order, even after a failure', async () => {
    const lock = new KyroLock();
    const log: string[] = [];
    let open: () => void = () => undefined;
    const slow = lock.run(async () => {
      log.push('a:start');
      await new Promise<void>((resolve) => {
        open = resolve;
      });
      log.push('a:end');
    });
    const failing = lock.run(() => {
      log.push('b');
      return Promise.reject(new Error('b failed'));
    });
    const last = lock.run(() => {
      log.push('c');
      return Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(log).toEqual(['a:start']);
    });
    open();
    await slow;
    await expect(failing).rejects.toThrow('b failed');
    await last;
    expect(log).toEqual(['a:start', 'a:end', 'b', 'c']);
  });

  it('never overlaps a slow kyro install with a Kyro update, in either order', async () => {
    const lock = new KyroLock();
    let active = 0;
    let maxActive = 0;
    const events: string[] = [];
    const tracked = async (label: string, ms: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      events.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`${label}:end`);
      active--;
    };

    const repo = new ProjectRepository(openDatabase(':memory:'));
    const dir = makeGitRepo();
    mkdirSync(join(dir, '.agents', 'kyro'), { recursive: true });
    const service = new ProjectService({
      repo,
      config: { projectsDir: dir, minFreeDiskGb: 1 },
      kyroInit: () => tracked('install', 60),
      kyroLock: lock,
    });
    const adopted = await repo.add({ name: 'demo', repoPath: dir, baseBranch: 'main' });
    const { updater, manager } = updaterSetup({
      lock,
      projects: [project('demo')],
      runner: async () => {
        await tracked('update', 20);
        return { exitCode: 0, output: 'ok' };
      },
    });

    // An install is in flight when the update is asked: the script waits for it.
    const install = (service as unknown as { initKyro(p: Project): Promise<void> }).initKyro(
      adopted,
    );
    await updater.start();
    await install;
    await updater.whenIdle();
    expect(events).toEqual(['install:start', 'install:end', 'update:start', 'update:end']);

    // An install arrives during an update: it waits for the update to end.
    events.length = 0;
    const slowUpdate = updaterSetup({
      lock,
      projects: [project('demo')],
      runner: async () => {
        await tracked('update', 60);
        return { exitCode: 0, output: 'ok' };
      },
    });
    await slowUpdate.updater.start();
    await vi.waitFor(() => {
      expect(events).toEqual(['update:start']);
    });
    const late = (service as unknown as { initKyro(p: Project): Promise<void> }).initKyro(adopted);
    await late;
    await slowUpdate.updater.whenIdle();
    expect(events).toEqual(['update:start', 'update:end', 'install:start', 'install:end']);
    expect(maxActive).toBe(1);
    expect(manager.inMaintenance).toBe(false);
  });
});

describe('bashRunner', () => {
  const script = (body: string) => {
    const path = join(mkdtempSync(join(tmpdir(), 'panel-upd-')), 's.sh');
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    return path;
  };

  it('passes the roots as argv and merges stdout and stderr', async () => {
    const path = script('echo "args: $*"; echo oops >&2');
    const result = await bashRunner([path, '/a b', '/c'], 5_000);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('args: /a b /c');
    expect(result.output).toContain('oops');
  });

  it('reports the exit code and a timeout without rejecting', async () => {
    expect(await bashRunner([script('exit 3')], 5_000)).toMatchObject({ exitCode: 3 });
    const slow = await bashRunner([script('sleep 5')], 100);
    expect(slow.exitCode).not.toBe(0);
    expect(slow.output).toContain('timeout');
  });
});
