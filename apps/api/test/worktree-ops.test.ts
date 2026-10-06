import { appendFileSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AutopilotRun, AutopilotStatus } from '@agents-panel/shared';
import { ChatEventBus } from '../src/chats/events.js';
import { ChatRepository } from '../src/chats/repo.js';
import { openDatabase } from '../src/db/index.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { ProjectRepoRepository } from '../src/projects/repos-repo.js';
import { WorktreeStateRepository } from '../src/worktrees/state-repo.js';
import { WorktreeOps, WorktreeOpsError } from '../src/worktrees/ops.js';
import { makeGitRepo, makeRepoWithRemote } from './helpers.js';

async function setup(options: { child?: boolean; setupCommand?: string } = {}) {
  const db = openDatabase(':memory:');
  const root = makeRepoWithRemote('feature/x');
  const projects = new ProjectRepository(db);
  const project = await projects.add({
    name: 'demo',
    repoPath: makeGitRepo(),
    baseBranch: 'main',
    ...(options.setupCommand ? { setupCommand: options.setupCommand } : {}),
  });
  const chats = new ChatRepository(db);
  const chat = chats.create({
    projectId: project.id,
    kind: 'work',
    slug: 'x',
    title: 'x',
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
  const flags = { running: false, maintenance: false };
  let pilot: AutopilotStatus | undefined;
  const ops = new WorktreeOps({
    chats,
    projects,
    projectRepos,
    manager: {
      isRunning: () => flags.running,
      get inMaintenance() {
        return flags.maintenance;
      },
    },
    autopilot: {
      get: (chatId) =>
        pilot === undefined ? undefined : ({ chatId, status: pilot } as unknown as AutopilotRun),
    },
    state,
    envFiles: { readAll: () => [] },
  });
  return {
    ops,
    chat,
    root,
    child,
    state,
    flags,
    setPilot: (status: AutopilotStatus | undefined) => {
      pilot = status;
    },
  };
}

const head = (s: { root: { repo: string; git: (d: string, ...a: string[]) => string } }) =>
  s.root.git(s.root.repo, 'rev-parse', 'HEAD').trim();

describe('WorktreeOps.status', () => {
  it('returns one result per repo with branch, changes, ahead/behind and the child base from project_repos', async () => {
    const s = await setup({ child: true });
    writeFileSync(join(s.root.repo, 'new.txt'), 'x');
    const status = await s.ops.status(s.chat.id);
    expect(status.repos.map((r) => r.path)).toEqual(['.', 'fe']);
    const [root, fe] = status.repos;
    expect(root?.branch).toBe('feature/x');
    expect(root?.baseBranch).toBe('main');
    expect(root?.files.map((f) => f.path)).toContain('new.txt');
    expect(root?.ahead).toBeNull(); // not pushed yet
    expect(fe?.baseBranch).toBe('dev');
    expect(fe?.branch).toBe('feature/x');

    await s.ops.push(s.chat.id, '.');
    const after = await s.ops.status(s.chat.id);
    expect(after.repos[0]?.ahead).toBe(0);
    expect(after.repos[0]?.behind).toBe(0);
  });

  it('404s a chat without a worktree', async () => {
    const s = await setup();
    await expect(s.ops.status(9999)).rejects.toMatchObject({ status: 404 });
  });
});

describe('WorktreeOps guards', () => {
  it('409s every operation while the agent runs and leaves the repo alone', async () => {
    const s = await setup();
    s.flags.running = true;
    writeFileSync(join(s.root.repo, 'b.txt'), 'b');
    const before = head(s);
    const calls = [
      () => s.ops.commit(s.chat.id, '.', ['b.txt'], 'feat: b'),
      () => s.ops.pullBase(s.chat.id),
      () => s.ops.pullBranch(s.chat.id),
      () => s.ops.push(s.chat.id),
      () => s.ops.reinstall(s.chat.id),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ name: 'WorktreeOpsError', status: 409 });
    }
    expect(head(s)).toBe(before);
    expect(s.root.git(s.root.repo, 'status', '--porcelain')).toContain('b.txt');
  });

  it('409s with the pilot active, queued or waiting_quota, and works when paused', async () => {
    const s = await setup();
    for (const status of ['active', 'queued', 'waiting_quota'] as const) {
      s.setPilot(status);
      const error = await s.ops.push(s.chat.id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WorktreeOpsError);
      expect((error as WorktreeOpsError).status).toBe(409);
      expect((error as WorktreeOpsError).message).toContain(status);
    }
    expect(() => s.root.remoteRef('refs/heads/feature/x')).toThrow();
    for (const status of ['paused', 'off', 'stopped', 'finished'] as const) {
      s.setPilot(status);
      const out = await s.ops.status(s.chat.id);
      expect(out.repos).toHaveLength(1);
    }
    s.setPilot('paused');
    const pushed = await s.ops.push(s.chat.id);
    expect(pushed.repos[0]?.result).toBe('ok');
    expect(s.root.remoteRef('refs/heads/feature/x')).toBe(head(s));
  });

  it('409s during Kyro maintenance and for a second operation in the same chat', async () => {
    const s = await setup();
    s.flags.maintenance = true;
    await expect(s.ops.push(s.chat.id)).rejects.toMatchObject({ status: 409 });
    s.flags.maintenance = false;
    const results = await Promise.allSettled([s.ops.push(s.chat.id), s.ops.push(s.chat.id)]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { status: 409 } });
  });
});

describe('WorktreeOps.commit', () => {
  it('commits only the chosen file and records it in the Timeline as the user', async () => {
    const s = await setup();
    writeFileSync(join(s.root.repo, 'one.txt'), '1');
    writeFileSync(join(s.root.repo, 'two.txt'), '2');
    const out = await s.ops.commit(s.chat.id, '.', ['one.txt'], 'feat(api): uno');
    expect(out.result).toBe('ok');
    expect(out.warning).toBeUndefined();
    expect(s.root.git(s.root.repo, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe(
      'one.txt',
    );
    expect(s.root.git(s.root.repo, 'status', '--porcelain')).toContain('two.txt');

    const entry = s.state.timeline(s.chat.id).at(-1);
    expect(entry?.actor).toBe('user');
    expect(entry?.toState).toBe('escribiendo_codigo');
    expect(entry?.data).toMatchObject({ op: 'commit', repo: '.', result: 'ok' });
    // The fine state is untouched.
    expect(s.state.get(s.chat.id)).toMatchObject({
      state: 'escribiendo_codigo',
      detail: 'tarea T1',
    });
  });

  it('commits anyway with a warning when the message is not Conventional Commits', async () => {
    const s = await setup();
    writeFileSync(join(s.root.repo, 'one.txt'), '1');
    const before = head(s);
    const out = await s.ops.commit(s.chat.id, '.', ['one.txt'], 'arreglos varios');
    expect(out.result).toBe('ok');
    expect(out.warning).toContain('Conventional Commits');
    expect(head(s)).not.toBe(before);
  });

  it('rejects a repo that is not part of the work', async () => {
    const s = await setup();
    await expect(s.ops.commit(s.chat.id, '../etc', ['a'], 'feat: x')).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('WorktreeOps pulls', () => {
  it('aborts a conflicting pullBase, lists the files and offers the agent', async () => {
    const s = await setup();
    s.root.pushFromOther('a.txt', 'remoto', 'main');
    const before = head(s);
    const out = await s.ops.pullBase(s.chat.id);
    const root = out.repos[0];
    expect(root?.result).toBe('conflict');
    expect(root?.conflicts).toEqual(['a.txt']);
    expect(root?.askAgent).toBe(true);
    expect(head(s)).toBe(before);
    expect(existsSync(join(s.root.repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(s.root.git(s.root.repo, 'status', '--porcelain').trim()).toBe('');
    expect(s.state.timeline(s.chat.id).at(-1)?.data).toMatchObject({
      op: 'pull_base',
      result: 'conflict',
      conflicts: ['a.txt'],
    });
  });

  it('runs the setup after a pull that changed a lockfile, and not otherwise', async () => {
    const s = await setup({ setupCommand: 'touch setup-ran' });
    s.root.pushFromOther('other.txt', 'x', 'main');
    const plain = await s.ops.pullBase(s.chat.id);
    expect(plain.repos[0]?.result).toBe('ok');
    expect(plain.reinstall).toBeNull();
    expect(existsSync(join(s.root.repo, 'setup-ran'))).toBe(false);

    s.root.pushFromOther('package-lock.json', '{}', 'main');
    const locked = await s.ops.pullBase(s.chat.id);
    expect(locked.repos[0]?.lockfileChanged).toBe(true);
    expect(locked.reinstall?.result).toBe('ok');
    expect(existsSync(join(s.root.repo, 'setup-ran'))).toBe(true);
    const ops = s.state
      .timeline(s.chat.id)
      .map((t) => (t.data as { op?: string } | null)?.op)
      .filter(Boolean);
    expect(ops).toEqual(['pull_base', 'pull_base', 'reinstall']);
  });

  it('pullBranch brings the work branch from origin and reinstalls on a lockfile change', async () => {
    const s = await setup({ setupCommand: 'touch setup-ran' });
    await s.ops.push(s.chat.id);
    s.root.pushFromOther('go.sum', 'x', 'feature/x');
    const out = await s.ops.pullBranch(s.chat.id);
    expect(out.repos[0]?.result).toBe('ok');
    expect(out.reinstall?.result).toBe('ok');
    expect(existsSync(join(s.root.repo, 'setup-ran'))).toBe(true);
  });

  it('uses the base of the child repo, and a pull of one repo leaves the others alone', async () => {
    const s = await setup({ child: true });
    s.child?.pushFromOther('dev-only.txt', 'x', 'dev');
    const fe = join(s.root.repo, 'fe');
    const out = await s.ops.pullBase(s.chat.id, 'fe');
    expect(out.repos).toHaveLength(1);
    expect(out.repos[0]?.result).toBe('ok');
    expect(existsSync(join(fe, 'dev-only.txt'))).toBe(true);
  });
});

describe('WorktreeOps.push', () => {
  it('pushes the work branch without force and reports a remote that is ahead without retrying', async () => {
    const s = await setup();
    expect((await s.ops.push(s.chat.id)).repos[0]?.result).toBe('ok');
    const remoteBefore = s.root.remoteRef('refs/heads/feature/x');

    s.root.pushFromOther('r.txt', 'remote', 'feature/x');
    const remoteAhead = s.root.remoteRef('refs/heads/feature/x');
    writeFileSync(join(s.root.repo, 'l.txt'), 'l');
    await s.ops.commit(s.chat.id, '.', ['l.txt'], 'feat: l');
    const rejected = await s.ops.push(s.chat.id);
    expect(rejected.repos[0]?.result).toBe('error');
    expect(rejected.repos[0]?.output).toContain('git push');
    expect(s.root.remoteRef('refs/heads/feature/x')).toBe(remoteAhead);
    expect(remoteAhead).not.toBe(remoteBefore);
  });

  it('refuses to push the base branch of a repo', async () => {
    const s = await setup();
    s.root.git(s.root.repo, 'checkout', '-q', 'main');
    const out = await s.ops.push(s.chat.id);
    expect(out.repos[0]?.result).toBe('error');
    expect(() => s.root.remoteRef('refs/heads/feature/x')).toThrow();
  });
});

describe('WorktreeOps.reinstall', () => {
  it('runs the setup and records it', async () => {
    const s = await setup({ setupCommand: 'touch setup-ran' });
    const out = await s.ops.reinstall(s.chat.id);
    expect(out.result).toBe('ok');
    expect(existsSync(join(s.root.repo, 'setup-ran'))).toBe(true);
    expect(s.state.timeline(s.chat.id).at(-1)?.data).toMatchObject({ op: 'reinstall' });
  });
});
