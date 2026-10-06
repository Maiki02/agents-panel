import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentManager } from '../src/agent/manager.js';
import type { AgentEvent, RunParams } from '../src/agent/runner.js';
import { ChatEventBus } from '../src/chats/events.js';
import { QuestionRepository } from '../src/chats/questions-repo.js';
import { ChatRepository } from '../src/chats/repo.js';
import { AgentSessionRepository } from '../src/chats/sessions-repo.js';
import { openDatabase } from '../src/db/index.js';
import type { KyroActionResult, KyroReadResult } from '../src/kyro/reader.js';
import type { KyroTaskContext, KyroWorkState } from '../src/kyro/state.js';
import { Autopilot, type PilotKyro } from '../src/pilot/autopilot.js';
import { AutopilotRunRepository } from '../src/pilot/runs-repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { WorktreeStateRepository } from '../src/worktrees/state-repo.js';
import { WorktreeStateTracker } from '../src/worktrees/state-tracker.js';
import { FakeRunner } from './fake-runner.js';
import { makeGitRepo } from './helpers.js';

const REASON = 'el panel bloquea du, df y free';
const CAPABILITIES = ['record-evidence', 'review', 'close-sprint', 'analyze', 'context-pack'];

/** A work whose task W7 the agent blocked; every execute session blocks it again. */
class FakeWorkKyro implements PilotKyro {
  state: KyroWorkState = {
    kind: 'work',
    work: 'demo-work',
    status: 'active',
    revision: 12,
    nextAction: 'resolve_blocker',
    nextTaskId: 'W7',
    tasks: { done: 6, total: 7 },
    blockedReason: REASON,
  };
  unblocks: { work: string; task: string; revision: number }[] = [];
  unblockError: string | null = null;

  readScope(): Promise<never> {
    return Promise.reject(new Error('not a scope'));
  }
  readWork(): Promise<KyroReadResult<KyroWorkState>> {
    return Promise.resolve({ ok: true, state: structuredClone(this.state) });
  }
  capabilities(): Promise<KyroReadResult<string[]>> {
    return Promise.resolve({ ok: true, state: CAPABILITIES });
  }
  contextPackTask(): Promise<never> {
    return Promise.reject(new Error('not a scope'));
  }
  workContextPack(): Promise<KyroReadResult<KyroTaskContext>> {
    return Promise.resolve({
      ok: true,
      state: {
        kind: 'work',
        name: 'demo-work',
        nextAction: this.state.nextAction,
        sprintSlug: null,
        sprintObjective: null,
        taskId: this.state.nextTaskId,
        title: 'Verificación en la VM',
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
  analyze(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  completeScope(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  closeWork(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  unblockWorkTask(
    _cwd: string,
    work: string,
    task: string,
    revision: number,
  ): Promise<KyroActionResult> {
    if (this.unblockError !== null) {
      return Promise.resolve({
        ok: false,
        error: { kind: 'cli_failed', message: this.unblockError },
      });
    }
    this.unblocks.push({ work, task, revision });
    this.state = {
      ...this.state,
      revision: revision + 1,
      nextAction: 'execute_task',
      blockedReason: null,
    };
    return Promise.resolve({ ok: true });
  }
}

async function setup() {
  const db = openDatabase(':memory:');
  const project = await new ProjectRepository(db).add({
    name: 'demo',
    repoPath: makeGitRepo(),
    baseBranch: 'main',
  });
  const chats = new ChatRepository(db);
  const bus = new ChatEventBus();
  const kyro = new FakeWorkKyro();
  const states = new WorktreeStateRepository(db, chats, bus);
  const tracker = new WorktreeStateTracker(states, kyro);
  const questions = new QuestionRepository(db);
  const sessions = new AgentSessionRepository(db);
  const runner = new FakeRunner();
  const prompts: string[] = [];
  runner.script = (params: RunParams) => {
    prompts.push(params.prompt);
    // The agent tries again and blocks the task again (it still cannot run the commands).
    kyro.state = {
      ...kyro.state,
      revision: kyro.state.revision + 1,
      nextAction: 'resolve_blocker',
      blockedReason: 'sigue bloqueado',
    };
    const events: AgentEvent[] = [
      { type: 'system:init', payload: {}, sessionId: `sess-${String(prompts.length)}` },
      { type: 'result:success', payload: { result: 'ok' } },
    ];
    return events;
  };
  const manager = new AgentManager(chats, runner, bus, 4, questions, sessions, tracker);
  const runs = new AutopilotRunRepository(db);
  const pilot = new Autopilot({
    chats,
    runs,
    manager,
    kyro,
    tracker,
    questions,
    sessions,
    projectOf: () => ({ baseBranch: 'main', validateCommand: null }),
    maxSessionsPerSprint: 6,
    schedule: () => undefined,
  });
  const chat = chats.create({
    projectId: project.id,
    kind: 'work',
    slug: 'demo-work',
    title: 'demo-work',
    worktreePath: mkdtempSync(path.join(tmpdir(), 'wt-work-')),
    branch: 'feature/demo-work',
    status: 'idle',
  });
  tracker.created(chat);
  runs.create(chat.id);
  return { kyro, runs, states, pilot, chat, prompts, runner };
}

describe('resuming a work whose task Kyro holds as blocked', () => {
  it('unblocks the task once, runs it with the old reason in the prompt and stops if it blocks again', async () => {
    const t = await setup();
    t.pilot.resumeByUser(t.chat.id);
    await t.pilot.drive(t.chat.id);

    expect(t.kyro.unblocks).toEqual([{ work: 'demo-work', task: 'W7', revision: 12 }]);
    expect(t.prompts).toHaveLength(1);
    expect(t.prompts[0]).toContain(`Resumed by the user: Task W7 was blocked with: "${REASON}"`);
    // The agent blocked it again: no second unblock, the pilot stops until the next resume.
    expect(t.runs.get(t.chat.id)).toMatchObject({ status: 'stopped' });
    expect(t.states.get(t.chat.id)).toMatchObject({
      state: 'bloqueado',
      blockedReason: 'tarea_bloqueada',
    });
  });

  it('leaves the unblock in the Timeline', async () => {
    const t = await setup();
    t.pilot.resumeByUser(t.chat.id);
    await t.pilot.drive(t.chat.id);
    expect(t.states.timeline(t.chat.id).map((entry) => entry.reason)).toContain(
      'Reanudado por el usuario: el piloto desbloqueó W7 en Kyro',
    );
  });

  it('does not unblock anything when the loop was not started by the user', async () => {
    const t = await setup();
    await t.pilot.drive(t.chat.id);
    expect(t.kyro.unblocks).toEqual([]);
    expect(t.prompts).toEqual([]);
    expect(t.states.get(t.chat.id)?.blockedReason).toBe('tarea_bloqueada');
  });

  it('stops with kyro_bloqueado when Kyro refuses the unblock', async () => {
    const t = await setup();
    t.kyro.unblockError = 'revision mismatch';
    t.pilot.resumeByUser(t.chat.id);
    await t.pilot.drive(t.chat.id);
    expect(t.prompts).toEqual([]);
    expect(t.states.get(t.chat.id)).toMatchObject({
      blockedReason: 'kyro_bloqueado',
      detail: 'No se pudo desbloquear W7: revision mismatch',
    });
  });
});
