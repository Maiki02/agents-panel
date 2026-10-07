import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fingerprint } from '../src/pilot/decide.js';
import { describe, expect, it } from 'vitest';
import type { AutopilotStep } from '@agents-panel/shared';
import { AgentManager, AlreadyRunningError } from '../src/agent/manager.js';
import { buildQueryOptions } from '../src/agent/sdk-runner.js';
import type { AgentEvent, RunParams } from '../src/agent/runner.js';
import { ChatEventBus } from '../src/chats/events.js';
import { QuestionRepository } from '../src/chats/questions-repo.js';
import { ChatRepository } from '../src/chats/repo.js';
import { AgentSessionRepository } from '../src/chats/sessions-repo.js';
import { openDatabase } from '../src/db/index.js';
import type { KyroActionResult, KyroReadResult } from '../src/kyro/reader.js';
import type { MergeGit, PilotGit } from '../src/pilot/git-ops.js';
import type { SecretFinding } from '../src/pilot/secrets.js';
import type { PilotGh } from '../src/pilot/github-cli.js';
import type {
  AnalyzeFinding,
  KyroScopeState,
  KyroTaskContext,
  ScopeSummary,
} from '../src/kyro/state.js';
import {
  Autopilot,
  QUOTA_RETRY_MS,
  QUOTA_RESET_MARGIN_MS,
  usedSkill,
  hitUsageLimit,
  type PilotKyro,
} from '../src/pilot/autopilot.js';
import { POLICY_VERSION } from '../src/pilot/policy.js';
import { AutopilotRunRepository } from '../src/pilot/runs-repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { UsageRepository } from '../src/usage/repo.js';
import { WorktreeOps } from '../src/worktrees/ops.js';
import { WorktreeStateRepository } from '../src/worktrees/state-repo.js';
import { WorktreeStateTracker } from '../src/worktrees/state-tracker.js';
import { FakeRunner } from './fake-runner.js';
import { makeGitRepo } from './helpers.js';

const CAPABILITIES = ['record-evidence', 'review', 'close-sprint', 'analyze', 'context-pack'];

/** A scope of `total` sprints with one task each, moved by what the fake sessions do. */
class FakeKyro implements PilotKyro {
  state: KyroScopeState;
  capabilities_ = [...CAPABILITIES];
  findings: AnalyzeFinding[] = [];
  analyzeCalls = 0;
  /** When true a fix session does not clear the findings (to reach the session cap). */
  keepFindings = false;
  /** The scope of an approved idea: Kyro has none until the init session creates it. */
  missing = false;

  constructor(total = 2) {
    this.state = {
      kind: 'scope',
      scope: 'demo',
      status: 'active',
      nextAction: 'plan_sprint',
      nextTaskId: null,
      sprint: { current: null, closed: 0, total },
      tasks: { done: 0, total: 0 },
      openDebt: 0,
      pendingReview: 0,
      blockers: [],
    };
  }

  readScope(): Promise<KyroReadResult<KyroScopeState>> {
    if (this.missing) {
      return Promise.resolve({ ok: false, error: { kind: 'no_target', message: 'sin scope' } });
    }
    return Promise.resolve({ ok: true, state: structuredClone(this.state) });
  }
  readWork(): Promise<never> {
    return Promise.reject(new Error('not a work'));
  }
  capabilities(): Promise<KyroReadResult<string[]>> {
    return Promise.resolve({ ok: true, state: this.capabilities_ });
  }
  /** The task id each context-pack asked for (null: no --task). */
  packTasks: (string | null | undefined)[] = [];
  contextPackTask(
    _cwd: string,
    _scope: string,
    taskId?: string | null,
  ): Promise<KyroReadResult<KyroTaskContext>> {
    this.packTasks.push(taskId);
    return Promise.resolve({
      ok: true,
      state: {
        kind: 'scope',
        name: 'demo',
        nextAction: this.state.nextAction,
        sprintSlug: `s${String(this.state.sprint.current ?? 0)}`,
        sprintObjective: 'obj',
        taskId: this.state.nextTaskId,
        title: 't',
        description: 'd',
        files: [],
        context: null,
        criteria: [],
        scenarios: [],
        openDebt: 0,
        conventions: [],
      },
    });
  }
  workContextPack(): Promise<never> {
    return Promise.reject(new Error('not a work'));
  }
  scopeSummary(): Promise<KyroReadResult<ScopeSummary>> {
    return Promise.resolve({
      ok: true,
      state: { title: 'Mi scope', objective: 'Objetivo del scope', sprints: ['Sprint 1: uno'] },
    });
  }
  completed: string[] = [];
  /** When set, completing fails with this message. */
  completeError: string | null = null;

  completeScope(): Promise<KyroActionResult> {
    if (this.completeError !== null) {
      return Promise.resolve({
        ok: false,
        error: { kind: 'cli_failed', message: this.completeError },
      });
    }
    this.completed.push(`scope ${this.state.scope}`);
    this.state.nextAction = 'done';
    return Promise.resolve({ ok: true });
  }
  closeWork(): Promise<KyroActionResult> {
    return Promise.resolve({ ok: true });
  }
  analyze(): Promise<KyroReadResult<AnalyzeFinding[]>> {
    this.analyzeCalls++;
    return Promise.resolve({ ok: true, state: this.findings });
  }

  /** What a session of each step does to Kyro. */
  apply(step: string): void {
    const s = this.state;
    if (step === 'merge' || step === 'merge_dev') return;
    if (step === 'init') {
      this.missing = false;
      s.nextAction = 'plan_sprint';
    } else if (step === 'plan') {
      s.sprint.current = (s.sprint.closed ?? 0) + 1;
      s.nextAction = 'execute_task';
      s.nextTaskId = `T${String(s.sprint.current)}.1`;
      s.tasks.total += 1;
    } else if (step === 'execute') {
      s.nextAction = 'qa_or_close';
      s.nextTaskId = null;
      s.tasks.done += 1;
    } else if (step === 'fix') {
      if (!this.keepFindings) this.findings = [];
      s.tasks.done += 1;
    } else if (step === 'close') {
      const closed = (s.sprint.closed ?? 0) + 1;
      s.sprint.closed = closed;
      s.sprint.current = null;
      s.nextAction = closed < (s.sprint.total ?? 0) ? 'plan_sprint' : 'await_scope_completion';
    }
  }
}

function stepOf(prompt: string): string {
  if (prompt.includes('panel restarted')) return 'execute';
  if (prompt.includes('Create the scope of an approved idea')) return 'init';
  if (prompt.includes('Resolve the merge conflicts')) return 'merge';
  if (prompt.includes('with the merge-dev skill')) return 'merge_dev';
  if (prompt.includes('This is a planning session')) return 'plan';
  if (prompt.includes('Fix the findings')) return 'fix';
  if (prompt.includes('This is a closing session')) return 'close';
  return 'execute';
}

const qaEvent: AgentEvent = {
  type: 'assistant',
  payload: {
    message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'kyro-qa' } }] },
  },
};

function writeReport(cwd: string, sprintN: number, report: string | undefined): void {
  if (report === 'none') return;
  const dir = path.join(cwd, '.agents', 'kyro', 'qa', 'demo');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `sprint-${String(sprintN)}.md`);
  if (report === 'symlink') {
    const target = path.join(cwd, 'outside.md');
    writeFileSync(target, 'Verdict: APPROVED\n');
    symlinkSync(target, file);
    return;
  }
  writeFileSync(file, `${report ?? 'Verdict: APPROVED'}\n\nInforme.\n`);
}

/** Records the PRs instead of calling GitHub. */
class FakeGh implements PilotGh {
  created: { base: string; head: string; title: string; body: string }[] = [];
  open: string[] = [];
  openPr(): Promise<string | null> {
    return Promise.resolve(this.open[0] ?? null);
  }
  openPrsOf(): Promise<string[]> {
    return Promise.resolve(this.open);
  }
  createPr(
    _cwd: string,
    input: { base: string; head: string; title: string; bodyFile: string },
  ): Promise<string> {
    this.created.push({
      base: input.base,
      head: input.head,
      title: input.title,
      body: readFileSync(input.bodyFile, 'utf8'),
    });
    return Promise.resolve('https://github.com/o/r/pull/1');
  }
}

/** Records the commits of the closing instead of running git. */
class FakeGit implements PilotGit, MergeGit {
  commits: string[] = [];
  pushes: string[] = [];
  /** Moves when a closing session commits; the pilot compares it with the mark it took before. */
  headCounter = 0;
  base = 'base-1';
  pushError: string | null = null;
  /** The merge phase: what the pull finds, and what the merge session leaves behind. */
  pending = false;
  pulls: string[] = [];
  conflicts: string[] = [];
  merging = false;
  ancestor = false;
  branchName = 'feature/a';
  hasPendingChanges(): Promise<boolean> {
    return Promise.resolve(this.pending);
  }
  commitPending(): Promise<{ committed: boolean }> {
    this.pending = false;
    return Promise.resolve({ committed: true });
  }
  pull(_cwd: string, base: string): Promise<{ ok: boolean; output: string }> {
    this.pulls.push(base);
    if (this.conflicts.length > 0) {
      this.merging = true;
      return Promise.resolve({ ok: false, output: 'CONFLICT' });
    }
    return Promise.resolve({ ok: true, output: 'Already up to date.' });
  }
  unmergedPaths(): Promise<string[]> {
    return Promise.resolve(this.conflicts);
  }
  mergeInProgress(): Promise<boolean> {
    return Promise.resolve(this.merging);
  }
  currentBranch(): Promise<string> {
    return Promise.resolve(this.branchName);
  }
  isAncestor(): Promise<boolean> {
    return Promise.resolve(this.ancestor);
  }
  head(): Promise<string> {
    return Promise.resolve(`head-${String(this.headCounter)}`);
  }
  branchHead(): Promise<string> {
    return Promise.resolve(this.base);
  }
  push(_cwd: string, branch: string): Promise<void> {
    if (this.pushError !== null) return Promise.reject(new Error(this.pushError));
    this.pushes.push(branch);
    return Promise.resolve();
  }
  /** When set, the commit fails with this message. */
  error: string | null = null;
  commitKyro(_cwd: string, message: string): Promise<{ committed: boolean }> {
    if (this.error !== null) return Promise.reject(new Error(this.error));
    this.commits.push(message);
    return Promise.resolve({ committed: true });
  }
}

async function setup(
  opts: {
    total?: number;
    maxConcurrent?: number;
    maxSessions?: number;
    skipQa?: boolean;
    /** What the closing session leaves as QA report: file content, or no file / a symlink. */
    report?: string;
    /** The chat comes from an approved idea: no scope in Kyro yet, this document seeds it. */
    seedPath?: string;
    /** The init session leaves Kyro without a scope (it failed). */
    initFails?: boolean;
    /** The closing session leaves no new commit on the branch. */
    noCommit?: boolean;
    /** The merge session leaves the conflicts as they were. */
    leaveConflicts?: boolean;
  } = {},
) {
  const fakeGitRef = new FakeGit();
  const db = openDatabase(':memory:');
  const project = await new ProjectRepository(db).add({
    name: 'demo',
    repoPath: makeGitRepo(),
    baseBranch: 'main',
  });
  const chats = new ChatRepository(db);
  const bus = new ChatEventBus();
  const kyro = new FakeKyro(opts.total);
  kyro.missing = opts.seedPath !== undefined;
  const states = new WorktreeStateRepository(db, chats, bus);
  const tracker = new WorktreeStateTracker(states, kyro);
  const questions = new QuestionRepository(db);
  const sessions = new AgentSessionRepository(db);
  const runner = new FakeRunner();
  let n = 0;
  runner.script = (params: RunParams) => {
    const step = stepOf(params.prompt);
    // Only the pilot's prompts move Kyro; a manual message does nothing to it.
    if (params.prompt.includes('Autopilot policy') || params.prompt.includes('panel restarted')) {
      if (!(step === 'init' && opts.initFails === true)) kyro.apply(step);
    }
    if (step === 'close' && opts.noCommit !== true) fakeGitRef.headCounter++;
    if (step === 'merge' && opts.leaveConflicts !== true) {
      fakeGitRef.conflicts = [];
      fakeGitRef.merging = false;
    }
    if (step === 'close') writeReport(params.cwd, kyro.state.sprint.closed ?? 0, opts.report);
    n++;
    const events: AgentEvent[] = [
      { type: 'system:init', payload: {}, sessionId: `sess-${String(n)}` },
      { type: 'assistant', payload: { text: 'hecho' } },
    ];
    if (step === 'close' && opts.skipQa !== true) events.push(qaEvent);
    events.push({ type: 'result:success', payload: { result: 'ok' } });
    return events;
  };
  const manager = new AgentManager(
    chats,
    runner,
    bus,
    opts.maxConcurrent ?? 4,
    questions,
    sessions,
    tracker,
  );
  const runs = new AutopilotRunRepository(db);
  const usage = new UsageRepository(db);
  const fakeGit = fakeGitRef;
  const fakeGh = new FakeGh();
  const scanFindings: SecretFinding[] = [];
  const scheduled: { fn: () => void; ms: number }[] = [];
  let clock = 1_000_000;
  const pilot = new Autopilot({
    chats,
    runs,
    manager,
    kyro,
    tracker,
    questions,
    sessions,
    usage,
    git: fakeGit,
    gh: fakeGh,
    actions: WorktreeOps.forPilot({ chats, state: states, git: fakeGit, gh: fakeGh }),
    scan: () => Promise.resolve(scanFindings),
    projectOf: () => ({ baseBranch: 'main', validateCommand: null }),
    maxSessionsPerSprint: opts.maxSessions ?? 6,
    now: () => clock,
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
  });
  const newChat = (slug: string) =>
    chats.create({
      projectId: project.id,
      kind: 'scope',
      slug,
      title: slug,
      worktreePath: mkdtempSync(path.join(tmpdir(), `wt-${slug}-`)),
      branch: `feature/${slug}`,
      status: 'idle',
    });
  const chat = newChat('a');
  tracker.created(chat);
  runs.create(chat.id, null, opts.seedPath ?? null);
  return {
    db,
    chats,
    kyro,
    git: fakeGit,
    gh: fakeGh,
    secrets: scanFindings,
    states,
    tracker,
    sessions,
    usage,
    runner,
    manager,
    runs,
    pilot,
    chat,
    newChat,
    scheduled,
    tick: (ms: number) => (clock += ms),
    clock: () => clock,
  };
}

describe('Autopilot over a 2-sprint scope (S7)', () => {
  it('opens a new session per step with the model of its role and completes the scope at await_scope_completion', async () => {
    const t = await setup();
    await t.pilot.drive(t.chat.id);

    expect(t.runner.calls.map((c) => [c.role, c.model])).toEqual([
      ['thinker', 'claude-opus-5-5'],
      ['executor', 'claude-sonnet-5-5'],
      ['executor', 'claude-sonnet-5-5'],
      ['thinker', 'claude-opus-5-5'],
      ['executor', 'claude-sonnet-5-5'],
      ['executor', 'claude-sonnet-5-5'],
    ]);
    // Never resumes the previous SDK session: each step starts a new one.
    expect(t.runner.calls.every((c) => c.resumeSessionId === undefined)).toBe(true);
    expect(t.sessions.listByChat(t.chat.id).map((s) => [s.step, s.policyVersion])).toEqual(
      (['plan', 'execute', 'close', 'plan', 'execute', 'close'] as AutopilotStep[]).map((s) => [
        s,
        POLICY_VERSION,
      ]),
    );
    expect(t.kyro.analyzeCalls).toBe(2);
    // Plan and close have no next task: asking `--task` there makes Kyro fail ("No next task").
    expect(t.kyro.packTasks).toEqual([null, 'T1.1', null, null, 'T2.1', null]);
    expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'finished' });
    expect(t.states.get(t.chat.id)?.state).toBe('pr_lista');
    expect(t.kyro.completed).toEqual(['scope demo']);
    expect(t.git.commits).toEqual(['chore(kyro): completar scope demo']);
  });

  it('leaves every pilot transition in the Timeline with actor pilot, step, role, model and policy', async () => {
    const t = await setup({ total: 1 });
    await t.pilot.drive(t.chat.id);
    const pilot = t.states.timeline(t.chat.id).filter((x) => x.actor === 'pilot');
    expect(pilot.length).toBeGreaterThan(3);
    const started = pilot.find((x) => x.toState === 'planificando');
    expect(started).toMatchObject({ role: 'thinker', model: 'claude-opus-5-5' });
    expect(started?.data).toMatchObject({ step: 'plan', policyVersion: POLICY_VERSION });
    expect(pilot.every((x) => x.role !== null && x.model !== null)).toBe(true);
  });

  it('every prompt carries the policy of its step and never starts a session with bypassPermissions (S11)', async () => {
    const t = await setup({ total: 1 });
    await t.pilot.drive(t.chat.id);
    expect(t.runner.calls).toHaveLength(3);
    for (const call of t.runner.calls) {
      expect(call.prompt).toContain(`Autopilot policy v${String(POLICY_VERSION)}`);
      const options = buildQueryOptions(call, new AbortController());
      expect(options.permissionMode).toBe('acceptEdits');
      expect(options.permissionMode).not.toBe('bypassPermissions');
    }
  });
});

describe('quality gate (S9)', () => {
  it('a HIGH finding opens a fix step and not the closing', async () => {
    const t = await setup({ total: 1 });
    t.kyro.findings = [
      { id: 'A1', severity: 'HIGH', category: 'spec', detail: 'roto', remedy: '' },
      { id: 'A2', severity: 'MEDIUM', category: 'spec', detail: 'menor', remedy: '' },
    ];
    await t.pilot.drive(t.chat.id);
    expect(t.sessions.listByChat(t.chat.id).map((s) => s.step)).toEqual([
      'plan',
      'execute',
      'fix',
      'close',
    ]);
    const fix = t.runner.calls[2];
    expect(fix?.prompt).toContain('HIGH A1 (spec): roto');
    expect(fix?.prompt).not.toContain('menor');
    expect(t.kyro.analyzeCalls).toBe(2);
  });

  it('a MEDIUM finding does not block the closing', async () => {
    const t = await setup({ total: 1 });
    t.kyro.findings = [{ id: 'A1', severity: 'MEDIUM', category: 'spec', detail: 'x', remedy: '' }];
    await t.pilot.drive(t.chat.id);
    expect(t.sessions.listByChat(t.chat.id).map((s) => s.step)).toEqual([
      'plan',
      'execute',
      'close',
    ]);
  });

  it('a closing session that closed the sprint without kyro-qa blocks the work with qa_sin_correr', async () => {
    const t = await setup({ skipQa: true });
    await t.pilot.drive(t.chat.id);
    expect(t.states.get(t.chat.id)).toMatchObject({
      state: 'bloqueado',
      blockedReason: 'qa_sin_correr',
    });
    expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'stopped' });
    expect(t.runner.calls).toHaveLength(3);
  });
});

describe('push after each close (R12)', () => {
  it('pushes the branch of the worktree after every sprint that closed, after the completion and in the merge', async () => {
    const t = await setup();
    await t.pilot.drive(t.chat.id);
    // Two sprints, the completion and the merge: the same branch every time, never forced.
    expect(t.git.pushes).toEqual(['feature/a', 'feature/a', 'feature/a', 'feature/a']);
    expect(t.states.get(t.chat.id)?.state).toBe('pr_lista');
  });

  it('goes through the action service: push, Kyro commit and PR land in the Timeline as actor pilot, with the git_push event', async () => {
    const t = await setup({ total: 1 });
    await t.pilot.drive(t.chat.id);
    const ops = t.states
      .timeline(t.chat.id)
      .filter((e) => (e.data as { op?: string } | null)?.op !== undefined);
    const byOp = (op: string) => ops.filter((e) => (e.data as { op: string }).op === op);
    expect(byOp('push').length).toBeGreaterThanOrEqual(3);
    expect(byOp('commit_kyro')).toHaveLength(1);
    expect(byOp('open_pr')).toHaveLength(1);
    expect(ops.every((e) => e.actor === 'pilot')).toBe(true);
    expect(t.git.commits).toHaveLength(1);
    expect(t.gh.created).toHaveLength(1);
    const events = t.chats.allEventsAfter(t.chat.id, 0).filter((e) => e.type === 'git_push');
    expect(events).toHaveLength(t.git.pushes.length);
  });

  it('stops with git when the closing session left no new commit, and does not push', async () => {
    const t = await setup({ total: 1, noCommit: true });
    await t.pilot.drive(t.chat.id);
    expect(t.states.get(t.chat.id)).toMatchObject({ state: 'bloqueado', blockedReason: 'git' });
    expect(t.states.get(t.chat.id)?.detail).toContain('ningún commit nuevo');
    expect(t.git.pushes).toEqual([]);
  });

  it('stops with git when the local base branch moved during the closing', async () => {
    const t = await setup({ total: 1 });
    const base = t.runner.script;
    t.runner.script = (params) => {
      if (stepOf(params.prompt) === 'close') t.git.base = 'base-2';
      return base(params);
    };
    await t.pilot.drive(t.chat.id);
    expect(t.states.get(t.chat.id)).toMatchObject({ state: 'bloqueado', blockedReason: 'git' });
    expect(t.states.get(t.chat.id)?.detail).toContain('main');
    expect(t.git.pushes).toEqual([]);
  });

  it('stops with git and the output of git when the push fails, without retrying', async () => {
    const t = await setup({ total: 1 });
    t.git.pushError = 'git push falló: rejected (non-fast-forward)';
    await t.pilot.drive(t.chat.id);
    expect(t.states.get(t.chat.id)).toMatchObject({ state: 'bloqueado', blockedReason: 'git' });
    expect(t.states.get(t.chat.id)?.detail).toContain('non-fast-forward');
    expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'stopped' });
    expect(t.kyro.completed).toEqual([]);
  });
});

describe('merge phase (R14)', () => {
  it('opens the PR of the branch against the base with the objective and the sprints, and keeps the phase and URL in the run', async () => {
    const t = await setup({ total: 1 });
    await t.pilot.drive(t.chat.id);
    expect(t.git.pulls).toEqual(['main']);
    expect(t.gh.created).toHaveLength(1);
    expect(t.gh.created[0]).toMatchObject({ base: 'main', head: 'feature/a', title: 'Mi scope' });
    expect(t.gh.created[0]?.body).toContain('Objetivo del scope');
    expect(t.gh.created[0]?.body).toContain('- Sprint 1: uno');
    expect(t.runs.get(t.chat.id)).toMatchObject({
      status: 'finished',
      phase: 'merge',
      prUrls: ['https://github.com/o/r/pull/1'],
    });
    // The actions of the service (push, PR) add their own entries on the same state: not transitions.
    const states = t.states
      .timeline(t.chat.id)
      .filter((x) => (x.data as { op?: string } | null)?.op === undefined)
      .map((x) => x.toState);
    expect(states.slice(-5)).toEqual([
      'cerrando',
      'trayendo_dev',
      'validando_post_merge',
      'abriendo_pr',
      'pr_lista',
    ]);
    expect(t.states.get(t.chat.id)?.state).toBe('pr_lista');
  });

  it('with conflicts opens a merge session with the executor and goes on when they are resolved', async () => {
    const t = await setup({ total: 1 });
    t.git.conflicts = ['shared.txt'];
    await t.pilot.drive(t.chat.id);
    const steps = t.sessions.listByChat(t.chat.id).map((s) => s.step);
    expect(steps.at(-1)).toBe('merge');
    const merge = t.runner.calls.at(-1);
    expect(merge).toMatchObject({ role: 'executor', model: 'claude-sonnet-5-5' });
    expect(merge?.prompt).toContain('shared.txt');
    expect(merge?.prompt).toContain('git commit --no-edit');
    expect(t.states.timeline(t.chat.id).map((x) => x.toState)).toContain('resolviendo_conflictos');
    expect(t.gh.created).toHaveLength(1);
    expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'finished' });
  });

  it('stops with conflicto when the merge session leaves paths unmerged, and opens no PR', async () => {
    const t = await setup({ total: 1, leaveConflicts: true });
    t.git.conflicts = ['shared.txt'];
    await t.pilot.drive(t.chat.id);
    expect(t.states.get(t.chat.id)).toMatchObject({
      state: 'bloqueado',
      blockedReason: 'conflicto',
    });
    expect(t.states.get(t.chat.id)?.detail).toContain('shared.txt');
    expect(t.gh.created).toEqual([]);
    expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'stopped', phase: 'merge' });
  });

  it('stops with secretos listing only files and kinds, before pushing the final branch', async () => {
    const t = await setup({ total: 1 });
    t.secrets.push({ file: 'src/a.ts', kind: 'github_token' });
    const pushesBefore = t.git.pushes.length;
    await t.pilot.drive(t.chat.id);
    expect(t.states.get(t.chat.id)).toMatchObject({
      state: 'bloqueado',
      blockedReason: 'secretos',
    });
    expect(t.states.get(t.chat.id)?.detail).toBe('src/a.ts (token de GitHub)');
    expect(t.gh.created).toEqual([]);
    // Only the pushes of the sprint close and of the completion happened.
    expect(t.git.pushes.length).toBe(pushesBefore + 2);
  });

  it('a restart in the merge phase resumes the merge without opening any Kyro session', async () => {
    const t = await setup({ total: 1 });
    t.kyro.state.nextAction = 'done';
    t.kyro.state.sprint.closed = 1;
    t.runs.setPhase(t.chat.id, 'merge');
    await t.pilot.drive(t.chat.id);
    expect(t.runner.calls).toHaveLength(0);
    expect(t.gh.created).toHaveLength(1);
    expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'finished' });
  });

  describe('with the merge-dev skill of the project', () => {
    const withSkill = async (opts: Parameters<typeof setup>[0] = {}) => {
      const t = await setup(opts);
      const skill = path.join(t.chat.worktreePath, '.claude', 'skills', 'merge-dev', 'SKILL.md');
      mkdirSync(path.dirname(skill), { recursive: true });
      writeFileSync(skill, '# merge-dev\n');
      return { t, skill };
    };

    it('opens a merge_dev session with the executor that reads the skill and finishes when the PRs are open', async () => {
      const { t, skill } = await withSkill({ total: 1 });
      t.gh.open = ['https://github.com/o/ventas/pull/4', 'https://github.com/o/ventas-api/pull/5'];
      await t.pilot.drive(t.chat.id);
      const call = t.runner.calls.at(-1);
      expect(t.sessions.listByChat(t.chat.id).at(-1)?.step).toBe('merge_dev');
      expect(call).toMatchObject({ role: 'executor' });
      expect(call?.prompt).toContain(skill);
      expect(call?.prompt).toContain('Never run "git merge --abort"');
      expect(call?.prompt).not.toContain('Never run "git push"');
      expect(t.gh.created).toEqual([]); // the skill opens the PRs, not the panel
      expect(t.runs.get(t.chat.id)).toMatchObject({
        status: 'finished',
        prUrls: ['https://github.com/o/ventas/pull/4', 'https://github.com/o/ventas-api/pull/5'],
      });
    });

    it('accepts a branch that already reached the base as the success signal', async () => {
      const { t } = await withSkill({ total: 1 });
      t.git.ancestor = true;
      await t.pilot.drive(t.chat.id);
      expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'finished', prUrls: [] });
      expect(t.states.get(t.chat.id)?.state).toBe('mergeada');
    });

    it('stops with merge_sin_pr when there is no PR and the branch is not in the base', async () => {
      const { t } = await withSkill({ total: 1 });
      await t.pilot.drive(t.chat.id);
      expect(t.states.get(t.chat.id)).toMatchObject({
        state: 'bloqueado',
        blockedReason: 'merge_sin_pr',
      });
      expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'stopped' });
    });
  });
});

describe('completing the scope (R18)', () => {
  it('without open debt the panel completes the scope, commits and does not ask', async () => {
    const t = await setup({ total: 1 });
    await t.pilot.drive(t.chat.id);
    expect(t.kyro.completed).toEqual(['scope demo']);
    expect(t.git.commits).toEqual(['chore(kyro): completar scope demo']);
    expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'finished' });
    const cerrando = t.states.timeline(t.chat.id).find((x) => x.toState === 'cerrando');
    expect(cerrando?.actor).toBe('pilot');
  });

  it('with open debt it stops once in esperando_aprobacion_cierre with the debt list and completes nothing', async () => {
    const t = await setup({ total: 1 });
    const base = t.runner.script;
    t.runner.script = (params) => {
      const events = base(params);
      if (stepOf(params.prompt) === 'close') {
        t.kyro.state.openDebt = 1;
        t.kyro.state.debtItems = [{ id: 'debt-9', title: 'Pendiente', priority: 'high' }];
      }
      return events;
    };
    await t.pilot.drive(t.chat.id);
    expect(t.kyro.completed).toEqual([]);
    expect(t.git.commits).toEqual([]);
    expect(t.states.get(t.chat.id)).toMatchObject({ state: 'esperando_aprobacion_cierre' });
    expect(t.states.timeline(t.chat.id).at(-1)).toMatchObject({
      toState: 'esperando_aprobacion_cierre',
      actor: 'pilot',
      data: { debt: [{ id: 'debt-9', title: 'Pendiente', priority: 'high' }] },
    });
    expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'stopped' });
  });

  it('a Kyro failure while completing stops with kyro_bloqueado and commits nothing', async () => {
    const t = await setup({ total: 1 });
    t.kyro.completeError = 'NOT_READY_TO_COMPLETE';
    await t.pilot.drive(t.chat.id);
    expect(t.states.get(t.chat.id)).toMatchObject({
      state: 'bloqueado',
      blockedReason: 'kyro_bloqueado',
    });
    expect(t.git.commits).toEqual([]);
  });

  it('a failed commit stops with the reason git', async () => {
    const t = await setup({ total: 1 });
    t.git.error = 'git commit falló: no identity';
    await t.pilot.drive(t.chat.id);
    expect(t.states.get(t.chat.id)).toMatchObject({ state: 'bloqueado', blockedReason: 'git' });
    expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'stopped' });
  });
});

describe('scope of an approved idea (init step)', () => {
  it('opens an init session with the thinker, kyro-forge and the idea path, then follows the normal loop', async () => {
    const t = await setup({ total: 1, seedPath: '.agents/kyro/plan/idea.md' });
    await t.pilot.drive(t.chat.id);
    expect(t.sessions.listByChat(t.chat.id).map((s) => s.step)).toEqual([
      'init',
      'plan',
      'execute',
      'close',
    ]);
    const init = t.runner.calls[0];
    expect(init).toMatchObject({ role: 'thinker', model: 'claude-opus-5-5' });
    expect(init?.prompt).toContain('kyro-forge/SKILL.md');
    expect(init?.prompt).toContain('.agents/kyro/plan/idea.md');
    expect(init?.prompt).toContain('Scope: a');
    expect(init?.prompt).toContain('Autopilot policy');
    expect(t.runner.calls.map((c) => c.resumeSessionId)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(t.states.get(t.chat.id)?.state).toBe('pr_lista');
  });

  it('stops with kyro_bloqueado when the init session leaves no scope, without opening another one', async () => {
    const t = await setup({ seedPath: '.agents/kyro/plan/idea.md', initFails: true });
    await t.pilot.drive(t.chat.id);
    expect(t.runner.calls).toHaveLength(1);
    expect(t.states.get(t.chat.id)).toMatchObject({
      state: 'bloqueado',
      blockedReason: 'kyro_bloqueado',
    });
  });

  it('a scope without a seed and without Kyro target stops as before, with no init', async () => {
    const t = await setup();
    t.kyro.missing = true;
    await t.pilot.drive(t.chat.id);
    expect(t.runner.calls).toHaveLength(0);
    expect(t.states.get(t.chat.id)).toMatchObject({ blockedReason: 'kyro_bloqueado' });
  });
});

describe('QA verdict of the closing session (debt-6)', () => {
  it.each(['Verdict: APPROVED', 'Verdict: APPROVED WITH NOTES'])(
    '%s lets the pilot go on',
    async (report) => {
      const t = await setup({ total: 1, report });
      await t.pilot.drive(t.chat.id);
      expect(t.states.get(t.chat.id)?.state).toBe('pr_lista');
    },
  );

  it.each([
    ['Verdict: CHANGES REQUIRED', 'CHANGES REQUIRED'],
    ['Verdict: REJECTED', 'REJECTED'],
    ['verdict: APPROVED', 'sin la línea'],
    ['Veredicto aprobado', 'sin la línea'],
    ['Verdict: APPROVED but not really', 'sin la línea'],
    ['none', 'sin informe'],
    ['symlink', 'sin informe'],
  ])('%s blocks with qa_sin_aprobar', async (report, detail) => {
    const t = await setup({ total: 1, report });
    await t.pilot.drive(t.chat.id);
    const state = t.states.get(t.chat.id);
    expect(state).toMatchObject({ state: 'bloqueado', blockedReason: 'qa_sin_aprobar' });
    expect(t.states.timeline(t.chat.id).at(-1)?.reason).toContain(detail);
    expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'stopped' });
  });
});

describe('a user message between waitForIdle and start (debt-7)', () => {
  /** Makes the next `times` calls of manager.start fail as if the user's turn got in first. */
  function busyStart(
    t: Awaited<ReturnType<typeof setup>>,
    times: number,
  ): { failed: () => number } {
    const original = t.manager.start.bind(t.manager);
    let failed = 0;
    t.manager.start = (...args: Parameters<typeof original>) => {
      if (failed < times) {
        failed++;
        throw new AlreadyRunningError('Chat is already running');
      }
      original(...args);
    };
    return { failed: () => failed };
  }

  it('opens the step after the busy turn, with no stop and without counting the failed attempt', async () => {
    const base = await setup({ total: 1 });
    await base.pilot.drive(base.chat.id);
    const t = await setup({ total: 1 });
    const busy = busyStart(t, 1);
    await t.pilot.drive(t.chat.id);
    expect(busy.failed()).toBe(1);
    expect(t.sessions.listByChat(t.chat.id).map((s) => s.step)).toEqual([
      'plan',
      'execute',
      'close',
    ]);
    expect(t.runs.get(t.chat.id)).toMatchObject({
      status: 'finished',
      sessionsInSprint: base.runs.get(base.chat.id)?.sessionsInSprint,
    });
    expect(t.states.get(t.chat.id)?.state).toBe('pr_lista');
  });

  it('stops with otro after 3 busy attempts in a row, with a readable reason', async () => {
    const t = await setup({ total: 1 });
    busyStart(t, 10);
    await t.pilot.drive(t.chat.id);
    expect(t.states.get(t.chat.id)).toMatchObject({ state: 'bloqueado', blockedReason: 'otro' });
    expect(t.states.timeline(t.chat.id).at(-1)?.reason).toContain('ocupado');
    expect(t.runner.calls).toHaveLength(0);
    expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'stopped', sessionsInSprint: 0 });
  });
});

describe('loop guards, capabilities, queue and usage limit', () => {
  it('stops with sin_avance when a session moves nothing (S12)', async () => {
    const t = await setup();
    let calls = 0;
    const base = t.runner.script;
    t.runner.script = (params) => {
      calls++;
      return calls === 2 ? [{ type: 'result:success', payload: {} }] : base(params);
    };
    await t.pilot.drive(t.chat.id);
    expect(t.states.get(t.chat.id)).toMatchObject({
      state: 'bloqueado',
      blockedReason: 'sin_avance',
    });
    expect(t.runs.get(t.chat.id)?.stopReason).toMatch(/sin que el estado avance/);
  });

  it('stops with tope_de_sesiones when a sprint reaches the cap (S12)', async () => {
    const t = await setup({ total: 1, maxSessions: 2 });
    // The findings never clear, so the sprint keeps asking for fixes until the cap.
    t.kyro.keepFindings = true;
    t.kyro.findings = [{ id: 'A1', severity: 'HIGH', category: 'spec', detail: 'x', remedy: '' }];
    await t.pilot.drive(t.chat.id);
    expect(t.states.get(t.chat.id)).toMatchObject({
      state: 'bloqueado',
      blockedReason: 'tope_de_sesiones',
    });
    expect(t.runs.get(t.chat.id)?.sessionsInSprint).toBe(2);
    // The execution closed a task, which restarted the count: the fixes are what the cap counts.
    expect(t.sessions.listByChat(t.chat.id).map((s) => s.step)).toEqual([
      'plan',
      'execute',
      'fix',
      'fix',
    ]);
  });

  it('a sprint with more tasks than the cap runs to its close, because every execution closes a task', async () => {
    const t = await setup({ total: 1, maxSessions: 2 });
    // Five tasks in the sprint: each execution session closes one and Kyro keeps routing execute.
    let left = 4;
    const apply = t.kyro.apply.bind(t.kyro);
    t.kyro.apply = (step: string) => {
      apply(step);
      if (step === 'execute' && left > 0) {
        left--;
        t.kyro.state.nextAction = 'execute_task';
        t.kyro.state.nextTaskId = `T1.${String(5 - left)}`;
      }
    };
    await t.pilot.drive(t.chat.id);
    expect(t.sessions.listByChat(t.chat.id).map((s) => s.step)).toEqual([
      'plan',
      'execute',
      'execute',
      'execute',
      'execute',
      'execute',
      'close',
    ]);
    expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'finished' });
  });

  it('a sprint that used the whole cap and closed does not stop the next one from being planned', async () => {
    const t = await setup({ total: 2, maxSessions: 2 });
    await t.pilot.drive(t.chat.id);
    // plan, execute and close of each sprint: the second one is planned after the first closed.
    expect(t.sessions.listByChat(t.chat.id).map((s) => s.step)).toEqual([
      'plan',
      'execute',
      'close',
      'plan',
      'execute',
      'close',
    ]);
    expect(t.states.get(t.chat.id)?.blockedReason).toBeNull();
  });

  it('stops with kyro_bloqueado before opening anything when record-evidence or review is missing', async () => {
    const t = await setup();
    t.kyro.capabilities_ = CAPABILITIES.filter((c) => c !== 'review');
    await t.pilot.drive(t.chat.id);
    expect(t.runner.calls).toHaveLength(0);
    expect(t.states.get(t.chat.id)).toMatchObject({
      state: 'bloqueado',
      blockedReason: 'kyro_bloqueado',
    });
    expect(t.states.get(t.chat.id)?.detail).toContain('review');
  });

  it('with the sessions full the run waits as en_cola and starts when one frees up', async () => {
    const t = await setup({ maxConcurrent: 1, total: 1 });
    const other = t.newChat('b');
    let release!: () => void;
    t.runner.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.manager.start(other.id, 'manual'); // takes the only slot
    await t.pilot.drive(t.chat.id);
    expect(t.runs.get(t.chat.id)?.status).toBe('queued');
    expect(t.states.get(t.chat.id)?.state).toBe('en_cola');
    expect(t.scheduled).toHaveLength(1);

    t.runner.gate = Promise.resolve();
    release();
    await t.manager.waitForIdle(other.id);
    t.pilot.drainQueue();
    await t.pilot.drive(t.chat.id);
    expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'finished' });
    expect(t.sessions.listByChat(t.chat.id).map((s) => s.step)).toEqual([
      'plan',
      'execute',
      'close',
    ]);
  });

  it('a rejected rate limit leaves sin_cupo_de_uso and retries after 15 minutes (S21)', async () => {
    const t = await setup({ total: 1 });
    const base = t.runner.script;
    let limited = true;
    t.runner.script = (params) =>
      limited
        ? [{ type: 'rate_limit_event', payload: { rate_limit_info: { status: 'rejected' } } }]
        : base(params);
    await t.pilot.drive(t.chat.id);
    expect(t.runs.get(t.chat.id)).toMatchObject({
      status: 'waiting_quota',
      retryAt: 1_000_000 + QUOTA_RETRY_MS,
    });
    expect(t.states.get(t.chat.id)?.state).toBe('sin_cupo_de_uso');
    expect(t.scheduled.map((s) => s.ms)).toEqual([QUOTA_RETRY_MS]);

    limited = false;
    t.scheduled[0]?.fn();
    await t.pilot.drive(t.chat.id);
    expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'finished' });
    expect(t.sessions.listByChat(t.chat.id).map((s) => s.step)).toContain('close');
  });

  const rejected = (resetsAt?: number) =>
    [
      {
        type: 'rate_limit_event',
        payload: {
          rate_limit_info: {
            status: 'rejected',
            rateLimitType: 'five_hour',
            ...(resetsAt === undefined ? {} : { resetsAt }),
          },
        },
      },
    ] satisfies AgentEvent[];

  it('retakes at resetsAt plus a margin when the rejected event brings a future one (S21)', async () => {
    const t = await setup({ total: 1 });
    t.runner.script = () => rejected(2000); // epoch seconds: 2_000_000 ms, clock is 1_000_000
    await t.pilot.drive(t.chat.id);
    const wait = 2_000_000 + QUOTA_RESET_MARGIN_MS - 1_000_000;
    expect(t.runs.get(t.chat.id)).toMatchObject({
      status: 'waiting_quota',
      retryAt: 1_000_000 + wait,
    });
    expect(t.scheduled.map((s) => s.ms)).toEqual([wait]);
    expect(t.states.get(t.chat.id)?.state).toBe('sin_cupo_de_uso');
    const entry = t.states.timeline(t.chat.id).find((e) => e.toState === 'sin_cupo_de_uso');
    expect(entry?.reason).toContain(new Date(1_000_000 + wait).toISOString());
  });

  it('keeps 15 minutes without resetsAt or with one already past', async () => {
    for (const events of [rejected(), rejected(500)]) {
      const t = await setup({ total: 1 });
      t.runner.script = () => events;
      await t.pilot.drive(t.chat.id);
      expect(t.runs.get(t.chat.id)?.retryAt).toBe(1_000_000 + QUOTA_RETRY_MS);
      expect(t.scheduled.map((s) => s.ms)).toEqual([QUOTA_RETRY_MS]);
    }
  });

  it('falls back to the saved window of the run account, never another account', async () => {
    const t = await setup({ total: 1 });
    t.db
      .prepare(
        "INSERT INTO claude_accounts (name, config_dir, active, created_at) VALUES ('otra', '/x', 0, 0)",
      )
      .run();
    const other = (
      t.db.prepare("SELECT id FROM claude_accounts WHERE name = 'otra'").get() as { id: number }
    ).id;
    const window = (resetsAt: number) => ({
      window: 'five_hour',
      utilization: null,
      status: 'rejected' as const,
      resetsAt,
      source: 'event' as const,
    });
    // The run's account is the main one (id 1); the other account resets later and must be ignored.
    t.usage.upsert(1, window(3_000_000));
    t.usage.upsert(other, window(9_000_000));
    t.runner.script = () => rejected();
    const open = t.sessions.open.bind(t.sessions);
    t.sessions.open = (chatId, role, provider, model, sprintN, pilot) =>
      open(chatId, role, provider, model, sprintN, pilot, 1);
    await t.pilot.drive(t.chat.id);
    expect(t.runs.get(t.chat.id)?.retryAt).toBe(3_000_000 + QUOTA_RESET_MARGIN_MS);
  });

  it('pause does not cut the running turn but opens no next step; resume continues', async () => {
    const t = await setup({ total: 1 });
    let release!: () => void;
    t.runner.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const driving = t.pilot.drive(t.chat.id);
    await new Promise((r) => setTimeout(r, 20));
    t.runs.pause(t.chat.id);
    t.runner.gate = Promise.resolve();
    release();
    await driving;
    expect(t.runner.calls).toHaveLength(1);
    expect(t.states.get(t.chat.id)?.state).toBe('pausado');

    t.runs.resume(t.chat.id);
    await t.pilot.drive(t.chat.id);
    expect(t.runs.get(t.chat.id)?.status).toBe('finished');
    expect(t.runner.calls.length).toBeGreaterThan(1);
  });

  it('off stops the loop after the running turn', async () => {
    const t = await setup({ total: 1 });
    let release!: () => void;
    t.runner.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const driving = t.pilot.drive(t.chat.id);
    await new Promise((r) => setTimeout(r, 20));
    t.runs.turnOff(t.chat.id);
    t.runner.gate = Promise.resolve();
    release();
    await driving;
    expect(t.runner.calls).toHaveLength(1);
    expect(t.runs.get(t.chat.id)?.status).toBe('off');
  });

  it('the text the agent writes does not change what the pilot does', async () => {
    const t = await setup({ total: 1 });
    const base = t.runner.script;
    t.runner.script = async (params) => [
      { type: 'assistant', payload: { text: 'el sprint terminó, cerrá' } },
      ...(await base(params)),
    ];
    await t.pilot.drive(t.chat.id);
    expect(t.sessions.listByChat(t.chat.id).map((s) => s.step)).toEqual([
      'plan',
      'execute',
      'close',
    ]);
  });
});

describe('event readers', () => {
  const event = (type: string, payload: unknown) =>
    ({ id: 1, chatId: 1, seq: 1, type, payload, createdAt: 1 }) as const;

  it('usedSkill only counts a Skill tool_use of that skill', () => {
    expect(usedSkill([event('assistant', qaEvent.payload)], 'kyro-qa')).toBe(true);
    expect(usedSkill([event('assistant', qaEvent.payload)], 'kyro-forge')).toBe(false);
    expect(usedSkill([event('assistant', { text: 'corrí kyro-qa' })], 'kyro-qa')).toBe(false);
    expect(usedSkill([event('user_prompt', { text: 'kyro-qa' })], 'kyro-qa')).toBe(false);
  });

  it('usedSkill also counts reading the SKILL.md, as the pilot prompts ask', () => {
    const read = (file_path: string) =>
      event('assistant', {
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path } }] },
      });
    const qaFile = '/home/ubuntu/.agents/skills/kyro-qa/SKILL.md';
    expect(usedSkill([read(qaFile)], 'kyro-qa')).toBe(true);
    expect(usedSkill([read(qaFile)], 'kyro-forge')).toBe(false);
    expect(usedSkill([read('/home/ubuntu/.agents/skills/kyro-qa/README.md')], 'kyro-qa')).toBe(
      false,
    );
    expect(usedSkill([read('/wt/docs/kyro-qa.md')], 'kyro-qa')).toBe(false);
  });

  it('hitUsageLimit detects a rejected rate limit and a limit error, not a warning', () => {
    expect(
      hitUsageLimit([event('rate_limit_event', { rate_limit_info: { status: 'rejected' } })]),
    ).toBe(true);
    expect(
      hitUsageLimit([
        event('rate_limit_event', { rate_limit_info: { status: 'allowed_warning' } }),
      ]),
    ).toBe(false);
    expect(
      hitUsageLimit([
        event('result:error_during_execution', {
          is_error: true,
          result: 'Claude usage limit reached',
        }),
      ]),
    ).toBe(true);
    expect(hitUsageLimit([event('result:success', { is_error: false, result: 'ok' })])).toBe(false);
  });
});

describe('resuming after a restart (S16)', () => {
  /** A run in the middle of its execution step: Kyro at execute_task, an open SDK session. */
  async function midStep(opts: Parameters<typeof setup>[0] = {}) {
    const t = await setup({ total: 1, ...opts });
    t.kyro.apply('plan');
    t.runs.beginSession(t.chat.id, {
      step: 'execute',
      sprintN: 1,
      fingerprint: fingerprint(t.kyro.state),
      policyVersion: POLICY_VERSION,
    });
    t.sessions.open(t.chat.id, 'executor', 'claude', 'claude-sonnet-5-5', 1, {
      step: 'execute',
      policyVersion: POLICY_VERSION,
    });
    t.chats.setSessionId(t.chat.id, 'sess-old');
    t.chats.setStatus(t.chat.id, 'interrupted');
    return t;
  }

  it('resumes the same step with resume of the SDK session and no message from the user', async () => {
    const t = await midStep();
    t.pilot.resumeAll();
    await t.pilot.drive(t.chat.id);

    const first = t.runner.calls[0];
    expect(first).toMatchObject({ resumeSessionId: 'sess-old', role: 'executor' });
    expect(first?.prompt).toContain('panel restarted');
    const sessions = t.sessions.listByChat(t.chat.id);
    expect(sessions[0]).toMatchObject({ step: 'execute', result: 'interrupted' });
    expect(sessions[1]).toMatchObject({ step: 'execute' });
    // The resumed session counts for the sprint and the route goes on to the closing.
    expect(sessions.map((s) => s.step)).toEqual(['execute', 'execute', 'close']);
    expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'finished' });
  });

  it('resumes a cut plan session even though Kyro has no scope or work to read yet', async () => {
    const t = await setup({ total: 1 });
    t.kyro.missing = true;
    t.runs.beginSession(t.chat.id, {
      step: 'plan',
      sprintN: null,
      fingerprint: {},
      policyVersion: POLICY_VERSION,
    });
    t.sessions.open(t.chat.id, 'thinker', 'claude', 'claude-opus-5-5', null, {
      step: 'plan',
      policyVersion: POLICY_VERSION,
    });
    t.chats.setSessionId(t.chat.id, 'sess-plan');
    t.chats.setStatus(t.chat.id, 'interrupted');
    t.pilot.resumeAll();
    await t.pilot.drive(t.chat.id);

    expect(t.runner.calls[0]).toMatchObject({ resumeSessionId: 'sess-plan', role: 'thinker' });
    // The resumed session is a second plan session; the run only stops once it ends with no scope.
    expect(t.sessions.listByChat(t.chat.id).map((x) => x.step)).toEqual(['plan', 'plan']);
    expect(t.sessions.listByChat(t.chat.id)[0]).toMatchObject({
      step: 'plan',
      result: 'interrupted',
    });
  });

  it('still stops when Kyro cannot be read and no plan or init session was cut', async () => {
    const t = await setup({ total: 1 });
    t.kyro.missing = true;
    t.pilot.resumeAll();
    await t.pilot.drive(t.chat.id);
    expect(t.runner.calls).toHaveLength(0);
    expect(t.states.get(t.chat.id)).toMatchObject({
      state: 'bloqueado',
      blockedReason: 'kyro_bloqueado',
    });
  });

  it('does not resume a paused or switched-off run', async () => {
    const paused = await midStep();
    paused.runs.pause(paused.chat.id);
    paused.pilot.resumeAll();
    await paused.pilot.drive(paused.chat.id);
    expect(paused.runner.calls).toHaveLength(0);

    const off = await midStep();
    off.runs.turnOff(off.chat.id);
    off.pilot.resumeAll();
    await off.pilot.drive(off.chat.id);
    expect(off.runner.calls).toHaveLength(0);
  });

  it('a run waiting for the usage limit keeps its retry_at', async () => {
    const t = await midStep();
    t.runs.waitForQuota(t.chat.id, t.clock() + 5 * 60_000);
    t.pilot.resumeAll();
    expect(t.scheduled.map((x) => x.ms)).toEqual([5 * 60_000]);
    await t.pilot.drive(t.chat.id);
    expect(t.runner.calls).toHaveLength(0);

    t.scheduled[0]?.fn();
    await t.pilot.drive(t.chat.id);
    expect(t.runner.calls.length).toBeGreaterThan(0);
  });

  it('repeated restarts end in tope_de_sesiones, not in a loop', async () => {
    const t = await midStep({ maxSessions: 1 });
    t.pilot.resumeAll();
    await t.pilot.drive(t.chat.id);
    expect(t.runner.calls).toHaveLength(0);
    expect(t.states.get(t.chat.id)).toMatchObject({
      state: 'bloqueado',
      blockedReason: 'tope_de_sesiones',
    });
  });

  it('a run between steps (no open session) decides again from Kyro', async () => {
    const t = await setup({ total: 1 });
    t.pilot.resumeAll();
    await t.pilot.drive(t.chat.id);
    expect(t.sessions.listByChat(t.chat.id).map((s) => s.step)).toEqual([
      'plan',
      'execute',
      'close',
    ]);
    expect(t.runner.calls.every((c) => c.resumeSessionId === undefined)).toBe(true);
  });
});
