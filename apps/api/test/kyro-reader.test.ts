import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KyroReader, type CommandRunner } from '../src/kyro/reader.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'kyro');
const fixture = (name: string) => readFileSync(join(fixtures, name), 'utf8');

/** A worktree with Kyro files: scope "demo", sprint.json of the given fixture state. */
function worktree(state = 'execute_task', activeScope: string | null = 'demo'): string {
  const root = mkdtempSync(join(tmpdir(), 'panel-kyro-'));
  const kyro = join(root, '.agents', 'kyro');
  mkdirSync(join(kyro, 'scopes', 'demo'), { recursive: true });
  writeFileSync(
    join(kyro, 'local.json'),
    JSON.stringify(activeScope === null ? {} : { activeScope }),
  );
  writeFileSync(
    join(kyro, 'project.json'),
    JSON.stringify({ artifactRoot: '.agents/kyro/scopes' }),
  );
  cpSync(join(fixtures, `sprint.${state}.json`), join(kyro, 'scopes', 'demo', 'sprint.json'));
  return root;
}

interface Call {
  file: string;
  args: string[];
  cwd: string;
}

/** Fake CLI: answers context-pack, status full and work status from fixtures. */
function runner(opts: {
  pack?: string[];
  status?: string[];
  work?: string;
  raw?: string;
  fail?: Error;
}) {
  const calls: Call[] = [];
  let packIndex = 0;
  let statusIndex = 0;
  const run: CommandRunner = (file, args, { cwd }) => {
    calls.push({ file, args, cwd });
    if (opts.fail) return Promise.reject(opts.fail);
    if (opts.raw !== undefined) return Promise.resolve(opts.raw);
    if (args[0] === 'context-pack') {
      const list = opts.pack ?? ['execute_task'];
      return Promise.resolve(
        fixture(`context-pack.${list[Math.min(packIndex++, list.length - 1)] ?? ''}.json`),
      );
    }
    if (args[0] === 'status') {
      const list = opts.status ?? opts.pack ?? ['execute_task'];
      return Promise.resolve(
        fixture(`status-full.${list[Math.min(statusIndex++, list.length - 1)] ?? ''}.json`),
      );
    }
    return Promise.resolve(fixture(`work-status.${opts.work ?? 'execute_task'}.json`));
  };
  return { run, calls };
}

describe('KyroReader.readScope', () => {
  it('reads the scope from local.json with execFile argv and returns the state', async () => {
    const cwd = worktree();
    const { run, calls } = runner({});
    const result = await new KyroReader(run).readScope(cwd);
    expect(result).toMatchObject({
      ok: true,
      state: {
        scope: 'demo',
        nextAction: 'execute_task',
        sprint: { current: 1, closed: 0, total: 2 },
      },
    });
    expect(calls.map((c) => [c.file, ...c.args])).toEqual([
      ['kyro', 'context-pack', '--kyro-scope', 'demo', '--json'],
      ['kyro', 'status', 'full', '--kyro-scope', 'demo', '--json'],
    ]);
    expect(calls.every((c) => c.cwd === cwd)).toBe(true);
  });

  it('reads once more when context-pack and status disagree, and then succeeds', async () => {
    const { run, calls } = runner({
      pack: ['review_task', 'execute_task'],
      status: ['execute_task'],
    });
    const result = await new KyroReader(run).readScope(worktree());
    expect(result).toMatchObject({ ok: true, state: { nextAction: 'execute_task' } });
    expect(calls).toHaveLength(4);
  });

  it('returns a typed error when they keep disagreeing', async () => {
    const { run, calls } = runner({ pack: ['review_task'], status: ['execute_task'] });
    const result = await new KyroReader(run).readScope(worktree());
    expect(result).toMatchObject({ ok: false, error: { kind: 'unexpected_output' } });
    expect(calls).toHaveLength(4);
  });

  it('returns typed errors for a CLI failure, non-JSON output and a missing target', async () => {
    const failing = await new KyroReader(runner({ fail: new Error('timeout') }).run).readScope(
      worktree(),
    );
    expect(failing).toMatchObject({ ok: false, error: { kind: 'cli_failed', message: 'timeout' } });
    const garbage = await new KyroReader(runner({ raw: 'not json' }).run).readScope(worktree());
    expect(garbage).toMatchObject({ ok: false, error: { kind: 'unexpected_output' } });
    const noScope = await new KyroReader(runner({}).run).readScope(worktree('execute_task', null));
    expect(noScope).toMatchObject({ ok: false, error: { kind: 'no_target' } });
    const noKyro = await new KyroReader(runner({}).run).readScope(
      mkdtempSync(join(tmpdir(), 'x-')),
    );
    expect(noKyro).toMatchObject({ ok: false, error: { kind: 'no_target' } });
  });
});

describe('KyroReader.readWork', () => {
  function withWorks(slugs: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'panel-kyro-work-'));
    for (const slug of slugs)
      mkdirSync(join(root, '.agents', 'kyro', 'work', slug), { recursive: true });
    return root;
  }

  it('uses the only Work of the worktree', async () => {
    const { run, calls } = runner({ work: 'resolve_blocker' });
    const result = await new KyroReader(run).readWork(withWorks(['fix-login']));
    expect(result).toMatchObject({ ok: true, state: { nextAction: 'resolve_blocker' } });
    expect(calls[0]?.args).toEqual(['work', 'status', '--work', 'fix-login', '--json']);
  });

  it('uses the given slug and refuses an ambiguous worktree', async () => {
    const { run, calls } = runner({});
    const reader = new KyroReader(run);
    await reader.readWork(withWorks(['a', 'b']), 'b');
    expect(calls[0]?.args).toContain('b');
    const ambiguous = await reader.readWork(withWorks(['a', 'b']));
    expect(ambiguous).toMatchObject({ ok: false, error: { kind: 'no_target' } });
    const none = await reader.readWork(withWorks([]));
    expect(none).toMatchObject({ ok: false, error: { kind: 'no_target' } });
  });

  it('returns a typed error when the CLI fails', async () => {
    const result = await new KyroReader(runner({ fail: new Error('boom') }).run).readWork(
      withWorks(['w']),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'cli_failed' } });
  });
});

describe('KyroReader task context and capabilities', () => {
  function fake(outputs: Record<string, string>) {
    const calls: Call[] = [];
    const run: CommandRunner = (file, args, { cwd }) => {
      calls.push({ file, args, cwd });
      const out = outputs[args.slice(0, 2).join(' ')] ?? outputs[args[0] ?? ''];
      return out === undefined ? Promise.reject(new Error('no such verb')) : Promise.resolve(out);
    };
    return { calls, reader: new KyroReader(run) };
  }

  it('reads the task context of a scope with argv and no shell', async () => {
    const { calls, reader } = fake({
      'context-pack': fixture('context-pack-task.execute_task.json'),
    });
    const read = await reader.contextPackTask('/wt', 'demo', 'T1.1');
    expect(read).toMatchObject({ ok: true, state: { taskId: 'T1.1', name: 'demo' } });
    expect(calls).toEqual([
      {
        file: 'kyro',
        cwd: '/wt',
        args: [
          'context-pack',
          '--kyro-scope',
          'demo',
          '--task',
          'T1.1',
          '--verbosity',
          'detailed',
          '--json',
        ],
      },
    ]);
  });

  it('asks without --task when Kyro has no next task (close step), which would fail otherwise', async () => {
    const { calls, reader } = fake({
      'context-pack': fixture('context-pack-task.execute_task.json'),
    });
    await reader.contextPackTask('/wt', 'demo', null);
    expect(calls[0]?.args).toEqual([
      'context-pack',
      '--kyro-scope',
      'demo',
      '--verbosity',
      'detailed',
      '--json',
    ]);
  });

  it('unblocks a task of a work with the expected revision, as the user', async () => {
    const { calls, reader } = fake({ 'work unblock': '{"schemaVersion":1,"ok":true,"data":{}}' });
    expect(await reader.unblockWorkTask('/wt', 'demo-work', 'W7', 12)).toMatchObject({ ok: true });
    expect(calls[0]?.args).toEqual([
      'work',
      'unblock',
      '--work',
      'demo-work',
      '--task',
      'W7',
      '--expect-revision',
      '12',
      '--by',
      'user',
      '--json',
    ]);
  });

  it('reads the task context of a work', async () => {
    const { calls, reader } = fake({
      'work context-pack': fixture('work-context-pack.execute_task.json'),
    });
    expect(await reader.workContextPack('/wt', 'demo-work')).toMatchObject({
      ok: true,
      state: { kind: 'work', taskId: 'W1' },
    });
    expect(calls[0]?.args).toEqual(['work', 'context-pack', '--work', 'demo-work', '--json']);
  });

  it('reads the capabilities of the installed Kyro', async () => {
    const { reader } = fake({ capabilities: fixture('capabilities.json') });
    const read = await reader.capabilities('/wt');
    expect(read.ok && read.state).toEqual(expect.arrayContaining(['record-evidence', 'review']));
  });

  it('returns the failure instead of throwing', async () => {
    const { reader } = fake({});
    expect(await reader.capabilities('/wt')).toMatchObject({
      ok: false,
      error: { kind: 'cli_failed' },
    });
    expect(await reader.contextPackTask('/wt', 'demo')).toMatchObject({ ok: false });
    const bad = fake({ capabilities: '{"ok":true,"data":{}}' });
    expect(await bad.reader.capabilities('/wt')).toMatchObject({
      ok: false,
      error: { kind: 'unexpected_output' },
    });
  });
});

describe('KyroReader completion verbs', () => {
  const record = () => {
    const calls: Call[] = [];
    const run: CommandRunner = (file, args, options) => {
      calls.push({ file, args, cwd: options.cwd });
      return Promise.resolve('{}');
    };
    return { calls, reader: new KyroReader(run) };
  };

  it('completes a scope with scope complete --yes and never accepts debt on its own', async () => {
    const { calls, reader } = record();
    expect(await reader.completeScope('/w', 'demo')).toEqual({ ok: true });
    expect(calls).toEqual([
      { file: 'kyro', args: ['scope', 'complete', '--kyro-scope', 'demo', '--yes'], cwd: '/w' },
    ]);
    expect(calls[0]?.args).not.toContain('--accept-open-debt');
  });

  it('accepts open debt only with the reason the user gave', async () => {
    const { calls, reader } = record();
    await reader.completeScope('/w', 'demo', { reason: 'se hace en el sprint 5' });
    expect(calls[0]?.args).toEqual([
      'scope',
      'complete',
      '--kyro-scope',
      'demo',
      '--accept-open-debt',
      '--reason',
      'se hace en el sprint 5',
      '--yes',
    ]);
  });

  it('closes a work as completed against the expected revision', async () => {
    const { calls, reader } = record();
    await reader.closeWork('/w', 'w1', 7, 'listo');
    expect(calls[0]?.args).toEqual([
      'work',
      'close',
      '--work',
      'w1',
      '--outcome',
      'completed',
      '--reason',
      'listo',
      '--expect-revision',
      '7',
      '--by',
      'pilot',
      '--yes',
      '--json',
    ]);
  });

  it('returns the failure of the CLI instead of throwing', async () => {
    const reader = new KyroReader(() => Promise.reject(new Error('NOT_READY_TO_COMPLETE')));
    expect(await reader.completeScope('/w', 'demo')).toMatchObject({
      ok: false,
      error: { kind: 'cli_failed', message: 'NOT_READY_TO_COMPLETE' },
    });
  });
});

describe('KyroReader: the scope or work of the chat among existing ones', () => {
  const T0 = Date.parse('2026-10-05T00:00:00Z');
  const iso = (ms: number) => new Date(ms).toISOString();

  /** A worktree with works; `created` maps each slug to its work.json createdAt (ms). */
  function worksCreated(created: Record<string, number>): string {
    const root = mkdtempSync(join(tmpdir(), 'panel-kyro-work-'));
    for (const [slug, at] of Object.entries(created)) {
      const dir = join(root, '.agents', 'kyro', 'work', slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'work.json'), JSON.stringify({ createdAt: iso(at) }));
    }
    return root;
  }
  const workArg = (calls: { args: string[] }[]) => calls[0]?.args[3];

  it('reads the work named like the chat even when the repo has other works', async () => {
    const { run, calls } = runner({});
    const cwd = worksCreated({ 'capacidad-y-tiempos': T0, 'monorepo-skeleton': T0 });
    await new KyroReader(run).readWork(cwd, undefined, { preferred: 'capacidad-y-tiempos' });
    expect(workArg(calls)).toBe('capacidad-y-tiempos');
  });

  it('otherwise reads the single work created since the chat, ignoring the older ones', async () => {
    const { run, calls } = runner({});
    const cwd = worksCreated({ viejo: T0, 'mi-cambio': T0 + 3_600_000 });
    await new KyroReader(run).readWork(cwd, undefined, {
      preferred: 'otro-nombre',
      since: T0 + 1_000,
    });
    expect(workArg(calls)).toBe('mi-cambio');
  });

  it('says there is no work yet when only older ones exist, and refuses several new ones', async () => {
    const reader = new KyroReader(runner({}).run);
    const none = await reader.readWork(worksCreated({ viejo: T0, otro: T0 }), undefined, {
      since: T0 + 1_000,
    });
    expect(none).toMatchObject({ ok: false, error: { kind: 'no_target' } });
    expect(JSON.stringify(none)).toContain('Todavía no hay un Work');
    const several = await reader.readWork(
      worksCreated({ a: T0 + 5_000, b: T0 + 6_000 }),
      undefined,
      { since: T0 + 1_000 },
    );
    expect(several).toMatchObject({ ok: false, error: { kind: 'no_target' } });
    expect(JSON.stringify(several)).toContain('a, b');
  });

  it('treats a work.json that cannot be read as not created since the chat', async () => {
    const cwd = worksCreated({ bueno: T0 + 5_000 });
    mkdirSync(join(cwd, '.agents', 'kyro', 'work', 'roto'), { recursive: true });
    const { run, calls } = runner({});
    await new KyroReader(run).readWork(cwd, undefined, { since: T0 });
    expect(workArg(calls)).toBe('bueno');
  });

  it('keeps the old behaviour without hints, and an explicit work wins over the hints', async () => {
    const { run, calls } = runner({});
    const reader = new KyroReader(run);
    const ambiguous = await reader.readWork(worksCreated({ a: T0, b: T0 }));
    expect(ambiguous).toMatchObject({ ok: false, error: { kind: 'no_target' } });
    await reader.readWork(worksCreated({ a: T0, b: T0 }), 'b', { preferred: 'a', since: T0 + 1 });
    expect(workArg(calls)).toBe('b');
  });

  it('readScope uses the scope named like the chat when local.json has none, and local.json otherwise', async () => {
    const { run, calls } = runner({});
    const reader = new KyroReader(run);
    const noActive = worktree('execute_task', null);
    const byName = await reader.readScope(noActive, 'demo');
    expect(byName).toMatchObject({ ok: true });
    expect(calls[0]?.args).toContain('demo');
    // The chat's scope wins over a different activeScope of local.json.
    const other = worktree('execute_task', 'otro');
    await reader.readScope(other, 'demo');
    expect(calls.at(-1)?.args).toContain('demo');
    // A name with no scope folder falls back to local.json, and without it there is no target.
    await reader.readScope(worktree('execute_task', 'demo'), 'no-existe');
    expect(calls.at(-1)?.args).toContain('demo');
    const lost = await reader.readScope(noActive, 'no-existe');
    expect(lost).toMatchObject({ ok: false, error: { kind: 'no_target' } });
  });
});
