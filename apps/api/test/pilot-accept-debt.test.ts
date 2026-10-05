import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { WorktreeState, WorktreeTransition } from '@agents-panel/shared';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import type { KyroActionResult } from '../src/kyro/reader.js';
import type { KyroScopeState } from '../src/kyro/state.js';
import type { PilotKyro } from '../src/pilot/autopilot.js';
import type { MergeGit, PilotGit } from '../src/pilot/git-ops.js';
import type { PilotGh } from '../src/pilot/github-cli.js';
import { AutopilotRunRepository } from '../src/pilot/runs-repo.js';
import { ChatRepository } from '../src/chats/repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { WorktreeStateRepository } from '../src/worktrees/state-repo.js';
import { ChatEventBus } from '../src/chats/events.js';
import { PASSWORD, makeApp, makeKyroRepo, mutatingHeaders } from './helpers.js';

let apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

const DEBT = [{ id: 'debt-3', title: 'Algo', priority: 'medium' }];

async function boot(
  opts: {
    kind?: 'scope' | 'work';
    state?: string;
    completeFails?: boolean;
    gitFails?: boolean;
    pushFails?: boolean;
  } = {},
) {
  const scope: KyroScopeState = {
    kind: 'scope',
    scope: 'demo',
    status: 'active',
    nextAction: 'await_scope_completion',
    nextTaskId: null,
    sprint: { current: null, closed: 1, total: 1 },
    tasks: { done: 1, total: 1 },
    openDebt: 1,
    pendingReview: 0,
    blockers: [],
    debtItems: DEBT,
  };
  const completed: { scope: string; acceptOpenDebt: { reason: string } | undefined }[] = [];
  let done = false;
  const pilotKyro: PilotKyro = {
    // After completing, Kyro reports done so the resumed pilot finishes.
    readScope: () =>
      Promise.resolve({
        ok: true,
        state: { ...scope, nextAction: done ? 'done' : scope.nextAction },
      }),
    readWork: () => Promise.resolve({ ok: false, error: { kind: 'no_target', message: 'n/a' } }),
    capabilities: () =>
      Promise.resolve({
        ok: true,
        state: ['record-evidence', 'review', 'close-sprint', 'analyze', 'context-pack'],
      }),
    contextPackTask: () => Promise.reject(new Error('not used')),
    workContextPack: () => Promise.reject(new Error('not used')),
    analyze: () => Promise.resolve({ ok: true, state: [] }),
    completeScope: (_cwd, name, acceptOpenDebt): Promise<KyroActionResult> => {
      completed.push({ scope: name, acceptOpenDebt });
      if (opts.completeFails) {
        return Promise.resolve({ ok: false, error: { kind: 'cli_failed', message: 'OPEN_DEBT' } });
      }
      done = true;
      return Promise.resolve({ ok: true });
    },
    closeWork: () => Promise.resolve({ ok: true }),
  };
  const commits: string[] = [];
  const pushes: string[] = [];
  const pilotGit: PilotGit & MergeGit = {
    hasPendingChanges: () => Promise.resolve(false),
    commitPending: () => Promise.resolve({ committed: false }),
    pull: () => Promise.resolve({ ok: true, output: '' }),
    unmergedPaths: () => Promise.resolve([]),
    mergeInProgress: () => Promise.resolve(false),
    currentBranch: () => Promise.resolve('feature/demo'),
    isAncestor: () => Promise.resolve(false),
    head: () => Promise.resolve('h'),
    branchHead: () => Promise.resolve('b'),
    push: (_cwd, branch) => {
      if (opts.pushFails) return Promise.reject(new Error('git push falló: rejected'));
      pushes.push(branch);
      return Promise.resolve();
    },
    commitKyro: (_cwd, message) => {
      if (opts.gitFails) return Promise.reject(new Error('git commit falló: sin identidad'));
      commits.push(message);
      return Promise.resolve({ committed: true });
    },
  };
  const prs: string[] = [];
  const pilotGh: PilotGh = {
    openPr: () => Promise.resolve(null),
    openPrsOf: () => Promise.resolve([]),
    createPr: () => {
      prs.push('https://github.com/o/r/pull/9');
      return Promise.resolve('https://github.com/o/r/pull/9');
    },
  };
  const made = makeApp({}, undefined, { pilotKyro, pilotGit, pilotGh });
  apps.push(made.app);
  await made.app.ready();
  const user = await new UserRepository(made.db).create('alice', PASSWORD);
  const { token, csrfToken } = new SessionService(made.db, {
    idleTtlSeconds: 1800,
    absoluteTtlSeconds: 43200,
  }).create(user.id);
  const cookie = `${SESSION_COOKIE}=${token}`;
  const headers = mutatingHeaders(cookie, csrfToken);
  const project = await new ProjectRepository(made.db).add({
    name: 'demo',
    repoPath: makeKyroRepo(),
    baseBranch: 'main',
  });
  const chats = new ChatRepository(made.db);
  const chat = chats.create({
    projectId: project.id,
    kind: opts.kind ?? 'scope',
    slug: 'demo',
    title: 'demo',
    worktreePath: project.repoPath,
    branch: 'feature/demo',
    status: 'idle',
  });
  const states = new WorktreeStateRepository(made.db, chats, new ChatEventBus());
  states.transition(chat.id, {
    state: (opts.state ?? 'esperando_aprobacion_cierre') as WorktreeState['state'],
    actor: 'pilot',
    role: 'executor',
    model: 'claude-sonnet-5-5',
  });
  const runs = new AutopilotRunRepository(made.db);
  runs.create(chat.id);
  runs.stop(chat.id, 'El scope tiene deuda abierta');
  const url = `/api/chats/${String(chat.id)}/autopilot`;
  const post = (payload: object, h: Record<string, string> = headers) =>
    made.app.inject({ method: 'POST', url, headers: h, payload });
  return {
    ...made,
    chat: chat,
    userId: user.id,
    cookie,
    post,
    completed,
    commits,
    pushes,
    prs,
    runs,
    states,
  };
}

describe('accepting the open debt to complete a scope (T3.2)', () => {
  it('completes with --accept-open-debt and the reason, commits, records who accepted and resumes the pilot', async () => {
    const t = await boot();
    const res = await t.post({ action: 'accept_debt', reason: 'Se hace en el sprint 5' });
    expect(res.statusCode).toBe(200);
    expect(t.completed).toEqual([
      { scope: 'demo', acceptOpenDebt: { reason: 'Se hace en el sprint 5' } },
    ]);
    expect(t.commits).toEqual(['chore(kyro): completar scope demo aceptando deuda']);
    expect(t.pushes).toEqual(['feature/demo']);
    const entry = t.states
      .timeline(t.chat.id)
      .find((x: WorktreeTransition) => x.reason === 'Aceptó la deuda abierta y completó el scope');
    expect(entry).toMatchObject({
      actor: 'user',
      toState: 'cerrando',
      data: {
        action: 'accept_debt',
        userId: t.userId,
        username: 'alice',
        reason: 'Se hace en el sprint 5',
        debt: DEBT,
      },
    });
    // The pilot picked the work up again in the merge phase and did not ask about the debt again.
    for (let i = 0; i < 100 && t.runs.get(t.chat.id)?.status !== 'finished'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(t.runs.get(t.chat.id)).toMatchObject({
      status: 'finished',
      phase: 'merge',
      prUrls: ['https://github.com/o/r/pull/9'],
    });
    expect(t.prs).toHaveLength(1);
    expect(t.completed).toHaveLength(1);
  });

  it('needs a reason (400) and a state of esperando_aprobacion_cierre (409)', async () => {
    const t = await boot();
    expect((await t.post({ action: 'accept_debt' })).statusCode).toBe(400);
    expect((await t.post({ action: 'accept_debt', reason: '  ' })).statusCode).toBe(400);
    const other = await boot({ state: 'escribiendo_codigo' });
    expect((await other.post({ action: 'accept_debt', reason: 'ok' })).statusCode).toBe(409);
    expect(t.completed).toEqual([]);
    expect(other.completed).toEqual([]);
  });

  it('refuses a work (409), a missing session (401) and a missing CSRF (403)', async () => {
    const work = await boot({ kind: 'work' });
    expect((await work.post({ action: 'accept_debt', reason: 'x' })).statusCode).toBe(409);
    const t = await boot();
    const noSession = await t.post(
      { action: 'accept_debt', reason: 'x' },
      { origin: 'http://localhost:4200' },
    );
    expect(noSession.statusCode).toBe(401);
    const noCsrf = await t.post(
      { action: 'accept_debt', reason: 'x' },
      { cookie: t.cookie, origin: 'http://localhost:4200' },
    );
    expect(noCsrf.statusCode).toBe(403);
    expect(t.completed).toEqual([]);
  });

  it('refuses with 409 and runs nothing when the chat has no pilot run', async () => {
    const t = await boot();
    t.db.prepare('DELETE FROM autopilot_runs WHERE chat_id = ?').run(t.chat.id);
    const res = await t.post({ action: 'accept_debt', reason: 'x' });
    expect(res.statusCode).toBe(409);
    expect(t.completed).toEqual([]);
    expect(t.commits).toEqual([]);
    expect(t.pushes).toEqual([]);
    expect(t.states.get(t.chat.id)?.state).toBe('esperando_aprobacion_cierre');
  });

  it('answers 422 and changes nothing when Kyro refuses; blocks with git when the commit fails', async () => {
    const refused = await boot({ completeFails: true });
    const res = await refused.post({ action: 'accept_debt', reason: 'x' });
    expect(res.statusCode).toBe(422);
    expect(refused.states.get(refused.chat.id)?.state).toBe('esperando_aprobacion_cierre');
    expect(refused.commits).toEqual([]);

    const pushFails = await boot({ pushFails: true });
    expect((await pushFails.post({ action: 'accept_debt', reason: 'x' })).statusCode).toBe(422);
    expect(pushFails.states.get(pushFails.chat.id)).toMatchObject({
      state: 'bloqueado',
      blockedReason: 'git',
    });

    const gitFails = await boot({ gitFails: true });
    expect((await gitFails.post({ action: 'accept_debt', reason: 'x' })).statusCode).toBe(422);
    expect(gitFails.states.get(gitFails.chat.id)).toMatchObject({
      state: 'bloqueado',
      blockedReason: 'git',
    });
  });
});
