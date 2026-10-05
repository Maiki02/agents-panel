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
