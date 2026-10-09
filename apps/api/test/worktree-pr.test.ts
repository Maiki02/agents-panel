import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatEventBus } from '../src/chats/events.js';
import { ChatRepository } from '../src/chats/repo.js';
import { openDatabase } from '../src/db/index.js';
import type { PilotGh } from '../src/pilot/github-cli.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { ProjectRepoRepository } from '../src/projects/repos-repo.js';
import { WorktreeStateRepository } from '../src/worktrees/state-repo.js';
import type { KyroScopeState, PrData } from '../src/kyro/state.js';
import { WorktreeOps } from '../src/worktrees/ops.js';
import { makeGitRepo, makeRepoWithRemote } from './helpers.js';

interface Created {
  cwd: string;
  base: string;
  head: string;
  title: string;
  body: string;
}

function fakeGh(open: Record<string, string> = {}) {
  const created: Created[] = [];
  const gh: PilotGh = {
    openPr: (_cwd, head, base) => Promise.resolve(open[`${head}>${base}`] ?? null),
    openPrsOf: () => Promise.resolve([]),
    createPr: (cwd, input) => {
      created.push({
        cwd,
        base: input.base,
        head: input.head,
        title: input.title,
        // The body travels in a file that only exists during the call.
        body: readFileSync(input.bodyFile, 'utf8'),
      });
      return Promise.resolve(`https://github.com/acme/repo/pull/${String(created.length)}`);
    },
  };
  return { gh, created };
}

/** A Kyro reader that never runs the CLI. */
function fakeKyro(opts: { unreadable?: boolean; dataFails?: boolean } = {}) {
  const data: PrData = {
    kind: 'scope',
    slug: 'panel',
    title: 'T',
    objective: 'Objetivo X',
    tasks: [],
    sprints: [
      {
        n: 1,
        title: 'uno',
        tasks: [
          { id: 'T1', title: 'Tarea', description: '', summary: 'resumen T1', discarded: null },
        ],
      },
    ],
  };
  return {
    readScope: () =>
      Promise.resolve(
        opts.unreadable === true
          ? { ok: false as const, error: { kind: 'no_target' as const, message: 'sin scope' } }
          : { ok: true as const, state: { scope: 'panel' } as KyroScopeState },
      ),
    scopePrData: () =>
      opts.dataFails === true ? Promise.reject(new Error('boom')) : Promise.resolve(data),
  };
}

async function setup(
  options: {
    child?: boolean;
    open?: Record<string, string>;
    kyro?: ReturnType<typeof fakeKyro>;
    kind?: 'scope' | 'direct';
  } = {},
) {
  const db = openDatabase(':memory:');
  const root = makeRepoWithRemote('feature/x');
  const projects = new ProjectRepository(db);
  const project = await projects.add({
    name: 'demo',
    repoPath: makeGitRepo(),
    baseBranch: 'main',
  });
  const chats = new ChatRepository(db);
  const chat = chats.create({
    projectId: project.id,
    kind: options.kind ?? 'scope',
    slug: 'panel',
    title: 'Panel de PRs\ncon salto',
    worktreePath: root.repo,
    branch: 'feature/x',
    status: 'idle',
  });
  const projectRepos = new ProjectRepoRepository(db);
  let child: ReturnType<typeof makeRepoWithRemote> | undefined;
  if (options.child) {
    child = makeRepoWithRemote('feature/x');
    child.git(child.repo, 'push', '-q', 'origin', 'main:dev');
    renameSync(child.repo, join(root.repo, 'fe'));
    appendFileSync(join(root.repo, '.git', 'info', 'exclude'), 'fe/\n');
    const rows = projectRepos.syncDetected(project.id, 'main', ['fe']);
    const fe = rows.find((r) => r.path === 'fe');
    if (fe) projectRepos.updateBase(fe.id, 'dev');
  }
  const state = new WorktreeStateRepository(db, chats, new ChatEventBus());
  state.transition(chat.id, { state: 'escribiendo_codigo', actor: 'agent', detail: 'tarea T1' });
  const { gh, created } = fakeGh(options.open);
  const ops = new WorktreeOps({
    chats,
    projects,
    projectRepos,
    manager: { isRunning: () => false, inMaintenance: false },
    state,
    envFiles: { readAll: () => [] },
    gh,
    ...(options.kyro ? { kyro: options.kyro } : {}),
  });
  return { ops, chat, root, child, created, state };
}

describe('WorktreeOps.prPreview', () => {
  it('lists the repos with commits outside their base, with a one-line Conventional title and the log as body', async () => {
    const s = await setup({ child: true });
    const preview = await s.ops.prPreview(s.chat.id);
    expect(preview.hasMergeDev).toBe(false);
    expect(preview.repos.map((r) => r.path)).toEqual(['.', 'fe']);
    expect(preview.repos[0]).toMatchObject({
      baseBranch: 'main',
      branch: 'feature/x',
      commits: 1,
      openPrUrl: null,
      title: 'feat(panel): Panel de PRs con salto',
      body: '- feat: a',
    });
    expect(preview.repos[1]?.baseBranch).toBe('dev');
  });

  it('preloads the detailed body for a scope with readable Kyro, editable like any other', async () => {
    const s = await setup({ kyro: fakeKyro() });
    const body = (await s.ops.prPreview(s.chat.id)).repos[0]?.body;
    expect(body).toContain('Objetivo X');
    expect(body).toContain('**T1** — Tarea: resumen T1');
    expect(body).not.toContain('- feat: a');
  });

  it('keeps the commit list for a direct request or when Kyro cannot be read', async () => {
    const direct = await setup({ kyro: fakeKyro(), kind: 'direct' });
    expect((await direct.ops.prPreview(direct.chat.id)).repos[0]?.body).toBe('- feat: a');
    const broken = await setup({ kyro: fakeKyro({ unreadable: true }) });
    expect((await broken.ops.prPreview(broken.chat.id)).repos[0]?.body).toBe('- feat: a');
    const failing = await setup({ kyro: fakeKyro({ dataFails: true }) });
    expect((await failing.ops.prPreview(failing.chat.id)).repos[0]?.body).toBe('- feat: a');
  });

  it('leaves out a repo without commits outside its base and shows the open PR', async () => {
    const s = await setup({
      open: { 'feature/x>main': 'https://github.com/acme/repo/pull/7' },
    });
    expect((await s.ops.prPreview(s.chat.id)).repos[0]?.openPrUrl).toBe(
      'https://github.com/acme/repo/pull/7',
    );
    s.root.git(s.root.repo, 'reset', '-q', '--hard', 'main');
    expect((await s.ops.prPreview(s.chat.id)).repos).toEqual([]);
  });
});

describe('WorktreeOps.createPr', () => {
  it('pushes without force and opens the PR with the base, title and body asked for (S9)', async () => {
    const s = await setup();
    const out = await s.ops.createPr(s.chat.id, 'user', [
      { repo: '.', title: 'feat(panel): uno\ndos', body: 'Cuerpo\n- feat: a' },
    ]);
    expect(out.repos[0]).toMatchObject({
      path: '.',
      result: 'ok',
      url: 'https://github.com/acme/repo/pull/1',
      existing: false,
    });
    expect(s.created).toEqual([
      {
        cwd: s.root.repo,
        base: 'main',
        head: 'feature/x',
        title: 'feat(panel): uno dos',
        body: 'Cuerpo\n- feat: a',
      },
    ]);
    expect(s.root.remoteRef('refs/heads/feature/x')).toBe(
      s.root.git(s.root.repo, 'rev-parse', 'HEAD').trim(),
    );
    const entry = s.state.timeline(s.chat.id).at(-1);
    expect(entry?.actor).toBe('user');
    expect(entry?.data).toMatchObject({
      op: 'create_pr',
      url: 'https://github.com/acme/repo/pull/1',
    });
  });

  it('does not create another PR when one is open and answers its link (S10)', async () => {
    const link = 'https://github.com/acme/repo/pull/7';
    const s = await setup({ open: { 'feature/x>main': link } });
    const out = await s.ops.createPr(s.chat.id, 'user', [{ repo: '.', title: 't', body: '' }]);
    expect(out.repos[0]).toMatchObject({ result: 'ok', url: link, existing: true });
    expect(s.created).toEqual([]);
    expect(s.root.remoteRef('refs/heads/feature/x')).toBeTruthy(); // the push updated it
  });

  it('aborts a conflict bringing the base, lists the files and goes on with the next repo', async () => {
    const s = await setup({ child: true });
    s.root.pushFromOther('a.txt', 'remoto', 'main');
    const before = s.root.git(s.root.repo, 'rev-parse', 'HEAD');
    const out = await s.ops.createPr(s.chat.id, 'user', [
      { repo: '.', title: 'root', body: '' },
      { repo: 'fe', title: 'fe', body: '' },
    ]);
    expect(out.repos[0]).toMatchObject({
      result: 'conflict',
      conflicts: ['a.txt'],
      askAgent: true,
    });
    expect(out.repos[0]?.url).toBeUndefined();
    expect(existsSync(join(s.root.repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(s.root.git(s.root.repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(() => s.root.remoteRef('refs/heads/feature/x')).toThrow();
    expect(out.repos[1]).toMatchObject({ path: 'fe', result: 'ok' });
    expect(s.created.map((c) => [c.cwd.endsWith('/fe'), c.base])).toEqual([[true, 'dev']]);
  });

  it('a secret stops the push and the PR of that repo and names the file (S12)', async () => {
    const s = await setup();
    writeFileSync(join(s.root.repo, '.env'), 'TOKEN=abc\n');
    s.root.git(s.root.repo, 'add', '-f', '.env');
    s.root.git(s.root.repo, 'commit', '-q', '-m', 'feat: env');
    const out = await s.ops.createPr(s.chat.id, 'user', [{ repo: '.', title: 't', body: '' }]);
    expect(out.repos[0]).toMatchObject({ result: 'error', secrets: ['.env'] });
    expect(out.repos[0]?.output).toContain('.env');
    expect(s.created).toEqual([]);
    expect(() => s.root.remoteRef('refs/heads/feature/x')).toThrow();
  });

  it('rejects an empty title and a repo that is not of the work', async () => {
    const s = await setup();
    await expect(
      s.ops.createPr(s.chat.id, 'user', [{ repo: '.', title: ' \n ', body: '' }]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      s.ops.createPr(s.chat.id, 'user', [{ repo: 'nope', title: 't', body: '' }]),
    ).rejects.toMatchObject({ status: 404 });
    expect(s.created).toEqual([]);
  });
});
