import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { WorktreeStateId } from '@agents-panel/shared';
import { createGit, type Exec } from '../src/pilot/git-ops.js';
import { createPrArgs, listPrArgs, type PilotGh } from '../src/pilot/github-cli.js';
import { runGenericMerge, type MergeDeps, type MergeInput } from '../src/pilot/merge.js';
import {
  childRepos,
  runMergePhase,
  type MergePhaseDeps,
  type MergePhaseInput,
} from '../src/pilot/merge-phase.js';
import type { SecretFinding } from '../src/pilot/secrets.js';
import { makeGitRepo } from './helpers.js';

const execFileAsync = promisify(execFile);

// A fake value with the format of a GitHub token, built so the repo scan does not flag this file.
const TOKEN = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8',
  });

/** A bare origin, a worktree on feature/x with one commit, and a second clone to move the base. */
function repos() {
  const seed = makeGitRepo();
  const origin = mkdtempSync(join(tmpdir(), 'panel-origin-')) + '/o.git';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  sh(seed, 'remote', 'add', 'origin', origin);
  sh(seed, 'push', '-q', 'origin', 'main');
  const clone = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    execFileSync('git', ['clone', '-q', origin, dir]);
    return dir;
  };
  const wt = clone('panel-wt-');
  sh(wt, 'checkout', '-q', '-b', 'feature/x');
  writeFileSync(join(wt, 'feature.txt'), 'mine\n');
  sh(wt, 'add', '.');
  sh(wt, 'commit', '-q', '-m', 'feat: mine');
  const other = clone('panel-other-');
  const advanceBase = (file: string, text: string) => {
    writeFileSync(join(other, file), text);
    sh(other, 'add', '.');
    sh(other, 'commit', '-q', '-m', `chore: ${file}`);
    sh(other, 'push', '-q', 'origin', 'main');
  };
  const remoteRef = (ref: string) => {
    try {
      return execFileSync('git', ['-C', origin, 'rev-parse', '--verify', '--quiet', ref], {
        encoding: 'utf8',
      }).trim();
    } catch {
      return '';
    }
  };
  return { wt, other, advanceBase, remoteRef };
}

function harness(
  wt: string,
  opts: {
    validateCommand?: string | null;
    existingPr?: string | null;
    resolve?: (conflicts: readonly string[]) => Promise<'done' | 'exit'>;
  } = {},
) {
  const argvs: string[][] = [];
  const exec: Exec = (file, args, options) => {
    argvs.push([file, ...args]);
    return execFileAsync(file, args, { timeout: options.timeout, maxBuffer: 4 * 1024 * 1024 });
  };
  const marks: { state: WorktreeStateId; reason: string; data?: Record<string, unknown> }[] = [];
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const created: { base: string; head: string; title: string; body: string }[] = [];
  const sessions: (readonly string[])[] = [];
  const gh: PilotGh = {
    openPr: () => Promise.resolve(opts.existingPr ?? null),
    openPrsOf: () => Promise.resolve([]),
    createPr: (_cwd, input) => {
      created.push({
        base: input.base,
        head: input.head,
        title: input.title,
        body: readFileSync(input.bodyFile, 'utf8'),
      });
      return Promise.resolve('https://github.com/o/r/pull/7');
    },
  };
  const deps: MergeDeps = {
    git: createGit(exec),
    gh,
    mark: (state, reason, extra) => {
      marks.push({ state, reason, ...(extra?.data ? { data: extra.data } : {}) });
    },
    record: (type, payload) => events.push({ type, payload }),
    resolveConflicts: (conflicts) => {
      sessions.push(conflicts);
      return opts.resolve ? opts.resolve(conflicts) : Promise.resolve('done');
    },
  };
  const input: MergeInput = {
    chat: { worktreePath: wt, branch: 'feature/x' },
    base: 'main',
    project: {
      validateCommand:
        opts.validateCommand === undefined ? 'node -e "console.log(\'ok\')"' : opts.validateCommand,
    },
    name: 'scope demo',
    pr: { title: 'feat: demo', body: 'Objetivo del scope\n\n- Sprint 1' },
  };
  return { deps, input, argvs, marks, events, created, sessions };
}

const states = (marks: { state: WorktreeStateId }[]) => marks.map((m) => m.state);

describe('generic merge', () => {
  it('uses the push and PR hooks of the action service instead of git and gh when given', async () => {
    const r = repos();
    const h = harness(r.wt);
    const calls: string[] = [];
    const outcome = await runGenericMerge(
      {
        ...h.deps,
        push: () => {
          calls.push('push');
          return Promise.resolve();
        },
        openPr: (pr) => {
          calls.push(`pr:${pr.base}:${pr.title}`);
          return Promise.resolve('https://github.com/o/r/pull/9');
        },
      },
      h.input,
    );
    expect(outcome).toEqual({ kind: 'pr', url: 'https://github.com/o/r/pull/9' });
    expect(calls).toEqual(['push', 'pr:main:feat: demo']);
    expect(h.created).toEqual([]);
    expect(r.remoteRef('refs/heads/feature/x')).toBe('');
  });

  it('brings the base in, validates, pushes the branch and opens the PR against the base', async () => {
    const r = repos();
    r.advanceBase('base.txt', 'new in base\n');
    const h = harness(r.wt);
    const baseBefore = r.remoteRef('refs/heads/main');
    const outcome = await runGenericMerge(h.deps, h.input);

    expect(outcome).toEqual({ kind: 'pr', url: 'https://github.com/o/r/pull/7' });
    expect(states(h.marks)).toEqual([
      'trayendo_dev',
      'validando_post_merge',
      'abriendo_pr',
      'pr_lista',
    ]);
    expect(h.marks.at(-1)?.data).toEqual({ prUrl: 'https://github.com/o/r/pull/7' });
    expect(h.created).toEqual([
      {
        base: 'main',
        head: 'feature/x',
        title: 'feat: demo',
        body: 'Objetivo del scope\n\n- Sprint 1',
      },
    ]);
    expect(h.events[0]).toMatchObject({ type: 'validation', payload: { status: 'passed' } });
    // The base now lives in the branch, the branch is on the remote and the remote base did not move.
    expect(readFileSync(join(r.wt, 'base.txt'), 'utf8')).toBe('new in base\n');
    expect(r.remoteRef('refs/heads/feature/x')).toBe(sh(r.wt, 'rev-parse', 'HEAD').trim());
    expect(r.remoteRef('refs/heads/main')).toBe(baseBefore);
    expect(sh(r.wt, 'log', '--merges', '--oneline').trim()).not.toBe('');
  });

  it('opens the merge session over the conflicting paths and goes on once they are resolved', async () => {
    const r = repos();
    writeFileSync(join(r.wt, 'shared.txt'), 'mine\n');
    sh(r.wt, 'add', '.');
    sh(r.wt, 'commit', '-q', '-m', 'feat: shared');
    r.advanceBase('shared.txt', 'theirs\n');
    const h = harness(r.wt, {
      resolve: (conflicts) => {
        expect(conflicts).toEqual(['shared.txt']);
        writeFileSync(join(r.wt, 'shared.txt'), 'mine\ntheirs\n');
        sh(r.wt, 'add', 'shared.txt');
        sh(r.wt, 'commit', '--no-edit', '-q');
        return Promise.resolve('done');
      },
    });
    const outcome = await runGenericMerge(h.deps, h.input);
    expect(outcome.kind).toBe('pr');
    expect(h.sessions).toEqual([['shared.txt']]);
    expect(states(h.marks)).toContain('resolviendo_conflictos');
    expect(h.marks.find((m) => m.state === 'resolviendo_conflictos')?.data).toEqual({
      conflicts: ['shared.txt'],
    });
  });

  it.each([
    ['paths left unmerged', () => Promise.resolve('done' as const), /sin mergear: shared\.txt/],
    [
      'the merge left open',
      (wt: string) => {
        writeFileSync(join(wt, 'shared.txt'), 'x\n');
        sh(wt, 'add', 'shared.txt');
        return Promise.resolve('done' as const);
      },
      /sigue abierto/,
    ],
  ])(
    'stops with conflicto when the session leaves %s, and pushes nothing',
    async (_name, fix, detail) => {
      const r = repos();
      writeFileSync(join(r.wt, 'shared.txt'), 'mine\n');
      sh(r.wt, 'add', '.');
      sh(r.wt, 'commit', '-q', '-m', 'feat: shared');
      r.advanceBase('shared.txt', 'theirs\n');
      const h = harness(r.wt, { resolve: () => fix(r.wt) });
      const outcome = await runGenericMerge(h.deps, h.input);
      expect(outcome).toMatchObject({ kind: 'stop', blockedReason: 'conflicto' });
      expect(outcome.kind === 'stop' ? outcome.detail : '').toMatch(detail);
      expect(r.remoteRef('refs/heads/feature/x')).toBe('');
      expect(h.created).toEqual([]);
    },
  );

  it('ends the phase without a PR when the merge session asks the loop to leave', async () => {
    const r = repos();
    writeFileSync(join(r.wt, 'shared.txt'), 'mine\n');
    sh(r.wt, 'add', '.');
    sh(r.wt, 'commit', '-q', '-m', 'feat: shared');
    r.advanceBase('shared.txt', 'theirs\n');
    const h = harness(r.wt, { resolve: () => Promise.resolve('exit') });
    expect(await runGenericMerge(h.deps, h.input)).toEqual({ kind: 'exit' });
    expect(h.created).toEqual([]);
  });

  it('stops with build_roto and opens no PR when validate_command fails after bringing changes', async () => {
    const r = repos();
    r.advanceBase('base.txt', 'x\n');
    const h = harness(r.wt, {
      validateCommand: 'node -e "console.error(\'roto\'); process.exit(2)"',
    });
    const outcome = await runGenericMerge(h.deps, h.input);
    expect(outcome).toMatchObject({ kind: 'stop', blockedReason: 'build_roto' });
    expect(outcome.kind === 'stop' ? outcome.detail : '').toContain('roto');
    expect(h.created).toEqual([]);
    expect(r.remoteRef('refs/heads/feature/x')).toBe('');
    expect(h.events[0]).toMatchObject({ type: 'validation', payload: { status: 'failed' } });
  });

  it('notes in the Timeline that there was no validation when the project has no validate_command', async () => {
    const r = repos();
    r.advanceBase('base.txt', 'x\n');
    const h = harness(r.wt, { validateCommand: null });
    const outcome = await runGenericMerge(h.deps, h.input);
    expect(outcome.kind).toBe('pr');
    expect(h.marks.find((m) => m.state === 'validando_post_merge')).toMatchObject({
      reason: 'Sin validate_command: no hubo validación',
      data: { validation: 'skipped' },
    });
    expect(h.events).toEqual([]);
  });

  it('does not validate again when the base brought nothing', async () => {
    const r = repos();
    const h = harness(r.wt);
    expect((await runGenericMerge(h.deps, h.input)).kind).toBe('pr');
    expect(h.events).toEqual([]);
    expect(h.marks.find((m) => m.state === 'validando_post_merge')?.data).toEqual({
      validation: 'not_needed',
    });
  });

  it('reuses the open PR of the branch instead of creating another', async () => {
    const r = repos();
    const h = harness(r.wt, { existingPr: 'https://github.com/o/r/pull/3' });
    expect(await runGenericMerge(h.deps, h.input)).toEqual({
      kind: 'pr',
      url: 'https://github.com/o/r/pull/3',
    });
    expect(h.created).toEqual([]);
  });

  it('stops with secretos, commits nothing and pushes nothing when pending work carries a secret', async () => {
    const r = repos();
    writeFileSync(join(r.wt, 'config.ts'), `export const t = '${TOKEN}';\n`);
    const h = harness(r.wt);
    const headBefore = sh(r.wt, 'rev-parse', 'HEAD');
    const outcome = await runGenericMerge(h.deps, h.input);
    expect(outcome).toMatchObject({ kind: 'stop', blockedReason: 'secretos' });
    const detail = outcome.kind === 'stop' ? outcome.detail : '';
    expect(detail).toContain('config.ts');
    expect(detail).not.toContain(TOKEN);
    expect(sh(r.wt, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(r.remoteRef('refs/heads/feature/x')).toBe('');
  });

  it('stops with secretos before the push when a committed file of the branch has one', async () => {
    const r = repos();
    writeFileSync(join(r.wt, '.env'), 'PORT=1\n');
    sh(r.wt, 'add', '-f', '.env');
    sh(r.wt, 'commit', '-q', '-m', 'oops');
    const h = harness(r.wt);
    const outcome = await runGenericMerge(h.deps, h.input);
    expect(outcome).toMatchObject({ kind: 'stop', blockedReason: 'secretos' });
    expect(r.remoteRef('refs/heads/feature/x')).toBe('');
    expect(h.created).toEqual([]);
  });

  it('commits pending work that is clean before bringing the base', async () => {
    const r = repos();
    writeFileSync(join(r.wt, 'pending.txt'), 'pending\n');
    const h = harness(r.wt);
    expect((await runGenericMerge(h.deps, h.input)).kind).toBe('pr');
    expect(sh(r.wt, 'status', '--porcelain').trim()).toBe('');
    expect(sh(r.wt, 'log', '--format=%s').split('\n')).toContain(
      'chore: cambios pendientes de scope demo',
    );
  });

  it('no git argv has --force, rebase or a refspec, the pull is a merge and the push never targets the base', async () => {
    const r = repos();
    writeFileSync(join(r.wt, 'shared.txt'), 'mine\n');
    sh(r.wt, 'add', '.');
    sh(r.wt, 'commit', '-q', '-m', 'feat: shared');
    r.advanceBase('shared.txt', 'theirs\n');
    const h = harness(r.wt, {
      resolve: () => {
        writeFileSync(join(r.wt, 'shared.txt'), 'both\n');
        sh(r.wt, 'add', 'shared.txt');
        sh(r.wt, 'commit', '--no-edit', '-q');
        return Promise.resolve('done');
      },
    });
    await runGenericMerge(h.deps, h.input);
    const flat = h.argvs.flat();
    expect(flat.some((a) => /force|rebase/.test(a) && a !== '--no-rebase')).toBe(false);
    expect(flat.filter((a) => a.includes('rebase'))).toEqual(['--no-rebase']);
    expect(flat.some((a) => a.startsWith('+') || a.includes(':'))).toBe(false);
    const pulls = h.argvs.filter((a) => a.includes('pull'));
    expect(pulls.map((a) => a.slice(a.indexOf('pull')))).toEqual([
      ['pull', '--no-rebase', '--no-edit', 'origin', 'main'],
    ]);
    const pushes = h.argvs.filter((a) => a.includes('push'));
    expect(pushes.map((a) => a.slice(a.indexOf('push')))).toEqual([
      ['push', '-u', 'origin', 'feature/x'],
    ]);
  });
});

describe('gh argv', () => {
  it('looks for the open PR of the branch into the base and creates it with the body in a file', () => {
    expect(listPrArgs('feature/x', 'main')).toEqual([
      'pr',
      'list',
      '--head',
      'feature/x',
      '--base',
      'main',
      '--state',
      'open',
      '--json',
      'url',
    ]);
    expect(
      createPrArgs({ base: 'main', head: 'feature/x', title: 't', bodyFile: '/tmp/b.md' }),
    ).toEqual([
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      'feature/x',
      '--title',
      't',
      '--body-file',
      '/tmp/b.md',
    ]);
  });
});

describe('merge phase with merge-dev and child repos', () => {
  function worktreeWithChild() {
    const root = mkdtempSync(join(tmpdir(), 'panel-root-'));
    mkdirSync(join(root, '.claude/skills/merge-dev'), { recursive: true });
    writeFileSync(join(root, '.claude/skills/merge-dev/SKILL.md'), '# merge-dev\n');
    mkdirSync(join(root, 'api/.git'), { recursive: true });
    mkdirSync(join(root, 'node_modules/x/.git'), { recursive: true }); // nested, not first-level
    mkdirSync(join(root, 'docs'), { recursive: true }); // a folder without .git
    return root;
  }

  it('finds the first-level folders that are git repos', async () => {
    const root = worktreeWithChild();
    const repos = await childRepos(root);
    expect(repos.map((r) => r.slice(root.length + 1))).toEqual(['api']);
  });

  function deps(root: string, over: { secrets?: Record<string, SecretFinding[]> } = {}) {
    const scanned: string[] = [];
    const lookedUp: [string, string][] = [];
    const marks: WorktreeStateId[] = [];
    const d: MergePhaseDeps = {
      git: {
        isAncestor: () => Promise.resolve(false),
        currentBranch: (cwd: string) =>
          Promise.resolve(cwd === root ? 'feature/x' : 'feature/x-api'),
      } as unknown as MergePhaseDeps['git'],
      gh: {
        openPrsOf: (cwd: string, head: string) => {
          lookedUp.push([cwd.slice(root.length), head]);
          return Promise.resolve([`https://github.com/o/${cwd === root ? 'root' : 'api'}/pull/1`]);
        },
      } as unknown as PilotGh,
      mark: (state) => marks.push(state),
      record: () => undefined,
      session: () => Promise.resolve('done'),
      conflictPrompt: () => '',
      scan: (cwd) => {
        scanned.push(cwd.slice(root.length));
        return Promise.resolve(over.secrets?.[cwd.slice(root.length)] ?? []);
      },
    };
    return { d, scanned, lookedUp, marks };
  }
  const input = (root: string): MergePhaseInput => ({
    chat: { worktreePath: root, branch: 'feature/x' },
    base: 'main',
    project: { validateCommand: null },
    name: 'w',
    pr: { title: 't', body: 'b' },
    mergeDevPrompt: 'p',
  });

  it('scans the root and every child repo and gathers the open PRs of each', async () => {
    const root = worktreeWithChild();
    const h = deps(root);
    const outcome = await runMergePhase(h.d, input(root));
    expect(h.scanned).toEqual(['', '/api']);
    expect(h.lookedUp).toEqual([
      ['', 'feature/x'],
      ['/api', 'feature/x-api'],
    ]);
    expect(outcome).toMatchObject({ kind: 'done', merged: false });
    expect(outcome.kind === 'done' ? outcome.prUrls : []).toContain(
      'https://github.com/o/api/pull/1',
    );
  });

  it('stops with secretos when a child repo has one, naming the child and never the value', async () => {
    const root = worktreeWithChild();
    const h = deps(root, { secrets: { '/api': [{ file: '.env', kind: 'env_file' }] } });
    const outcome = await runMergePhase(h.d, input(root));
    expect(outcome).toEqual({
      kind: 'stop',
      blockedReason: 'secretos',
      detail: 'api/.env (archivo .env)',
    });
  });
});
