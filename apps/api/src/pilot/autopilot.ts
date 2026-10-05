import type { AutopilotRun, AutopilotStep, Chat, ChatEvent, ModelRole } from '@agents-panel/shared';
import { SessionLimitError, MaintenanceError, type AgentManager } from '../agent/manager.js';
import type { ChatRepository } from '../chats/repo.js';
import type { AgentSessionRepository } from '../chats/sessions-repo.js';
import type { QuestionRepository } from '../chats/questions-repo.js';
import type { KyroReadResult } from '../kyro/reader.js';
import type {
  AnalyzeFinding,
  KyroScopeState,
  KyroTaskContext,
  KyroWorkState,
} from '../kyro/state.js';
import type { KyroStateReader, WorktreeStateTracker } from '../worktrees/state-tracker.js';
import {
  DEFAULT_MAX_SESSIONS_PER_SPRINT,
  decideNextStep,
  fingerprint,
  type LastSession,
} from './decide.js';
import { POLICY_VERSION } from './policy.js';
import {
  buildStepPrompt,
  checkCapabilities,
  type CapabilityReader,
  type PromptStep,
} from './prompts.js';
import type { AutopilotRunRepository } from './runs-repo.js';

/** Everything the pilot reads from the Kyro CLI. */
export interface PilotKyro extends KyroStateReader, CapabilityReader {
  contextPackTask(cwd: string, scope: string): Promise<KyroReadResult<KyroTaskContext>>;
  workContextPack(cwd: string, work: string): Promise<KyroReadResult<KyroTaskContext>>;
  analyze(cwd: string, scope: string): Promise<KyroReadResult<AnalyzeFinding[]>>;
}

export const QUOTA_RETRY_MS = 15 * 60 * 1000;
export const QUEUE_RETRY_MS = 30 * 1000;

export interface AutopilotDeps {
  chats: ChatRepository;
  runs: AutopilotRunRepository;
  manager: AgentManager;
  kyro: PilotKyro;
  tracker: WorktreeStateTracker;
  questions: QuestionRepository;
  /** Sessions of every chat; needed to resume an interrupted step after a restart. */
  sessions?: AgentSessionRepository;
  maxSessionsPerSprint?: number;
  now?: () => number;
  /** Runs `fn` after `ms`; injectable so tests do not wait 15 minutes. */
  schedule?: (fn: () => void, ms: number) => void;
}

/** Short prompt for a step that a restart cut: the policy was already given in its session. */
const CONTINUE_PROMPT = [
  'The panel restarted while you were working on this step and your session was interrupted.',
  'Continue the same step where it stopped: re-read "kyro context-pack --kyro-scope <scope> --task --json" (or "kyro work context-pack" for a work) to see where Kyro is, and keep following the autopilot policy you were given. Do not start over.',
].join('\n');

interface PendingResume {
  role: ModelRole;
  step: AutopilotStep;
  sprintN: number | null;
  policyVersion: number;
}

interface AfterClose {
  closedBefore: number;
  fromSeq: number;
}

const BLOCKING_SEVERITIES = new Set(['CRITICAL', 'HIGH']);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Tool calls of the assistant events: `{ name, input }` of each tool_use block. */
function toolUses(events: ChatEvent[]): { name: string; input: Record<string, unknown> }[] {
  const uses: { name: string; input: Record<string, unknown> }[] = [];
  for (const event of events) {
    if (event.type !== 'assistant') continue;
    const message = (event.payload as { message?: { content?: unknown } } | null)?.message;
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content as Record<string, unknown>[]) {
      if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
        const input = block['input'];
        uses.push({
          name: block['name'],
          input:
            typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {},
        });
      }
    }
  }
  return uses;
}

/** True when the session loaded the skill (an `assistant` tool_use of Skill with that name). */
export function usedSkill(events: ChatEvent[], skill: string): boolean {
  return toolUses(events).some(
    (use) => use.name === 'Skill' && text(use.input['skill']).includes(skill),
  );
}

/** True when the SDK reported the usage limit: a rejected rate-limit event or a limit error result. */
export function hitUsageLimit(events: ChatEvent[]): boolean {
  return events.some((event) => {
    const payload = event.payload as Record<string, unknown> | null;
    if (event.type === 'rate_limit_event') {
      const info = payload?.['rate_limit_info'] as { status?: unknown } | undefined;
      return info?.status === 'rejected' || payload?.['status'] === 'rejected';
    }
    return (
      event.type.startsWith('result:') &&
      payload?.['is_error'] === true &&
      /usage limit|limit reached|rate limit/i.test(text(payload['result']))
    );
  });
}

/**
 * The pilot: takes a scope or work with the autopilot on to the end of its Kyro route, one new SDK
 * session per step. Every choice comes from Kyro's signals (decideNextStep); the agent's text is
 * never read. It never changes the permission mode of a session.
 */
export class Autopilot {
  private readonly loops = new Map<number, Promise<void>>();
  /** Steps interrupted by a restart, to reopen in their SDK session on the next pass of the loop. */
  private readonly pendingResume = new Map<number, PendingResume>();
  private readonly max: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => void;

  constructor(private readonly deps: AutopilotDeps) {
    this.max = deps.maxSessionsPerSprint ?? DEFAULT_MAX_SESSIONS_PER_SPRINT;
    this.now = deps.now ?? Date.now;
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        setTimeout(fn, ms).unref();
      });
  }

  /** Starts (or continues) the loop of a chat in the background. */
  kick(chatId: number): void {
    void this.drive(chatId);
  }

  /** Same as kick, resolving when the loop leaves the active state; the tests await it. */
  drive(chatId: number): Promise<void> {
    const existing = this.loops.get(chatId);
    if (existing) return existing;
    const loop = this.loop(chatId)
      .catch((error: unknown) => {
        this.crashed(chatId, error);
      })
      .finally(() => {
        this.loops.delete(chatId);
        this.drainQueue();
      });
    this.loops.set(chatId, loop);
    return loop;
  }

  /** Starts the queued runs while there are free sessions. */
  drainQueue(): void {
    const { runs, manager } = this.deps;
    for (const run of runs.listByStatus('queued')) {
      if (!manager.hasCapacity()) break;
      if (this.loops.has(run.chatId)) continue;
      runs.dequeue(run.chatId);
      this.kick(run.chatId);
    }
  }

  private async loop(chatId: number): Promise<void> {
    const { chats, runs, manager, kyro, questions } = this.deps;
    let last: LastSession | null = null;
    let afterClose: AfterClose | null = null;
    for (;;) {
      let run = runs.get(chatId);
      const chat = chats.findById(chatId);
      if (!run || !chat) return;
      if (run.status === 'queued') run = runs.dequeue(chatId);
      if (run.status !== 'active') {
        this.leave(chat, run);
        return;
      }

      // A turn in progress (the first one, a manual message, a question) ends before the pilot acts.
      await manager.waitForIdle(chatId);
      run = runs.get(chatId) ?? run;
      if (run.status !== 'active') {
        this.leave(chat, run);
        return;
      }

      const cwd = chat.worktreePath;
      const blocked = await checkCapabilities(kyro, cwd);
      if (blocked?.kind === 'stop') {
        this.stop(chat, blocked);
        return;
      }
      const read = chat.kind === 'scope' ? await kyro.readScope(cwd) : await kyro.readWork(cwd);
      if (!read.ok) {
        this.stop(chat, {
          state: 'bloqueado',
          blockedReason: 'kyro_bloqueado',
          detail: read.error.message,
        });
        return;
      }
      const state = read.state;

      const resume = this.pendingResume.get(chatId);
      if (resume !== undefined) {
        this.pendingResume.delete(chatId);
        const resumed = await this.resumeStep(chat, resume, state);
        if (resumed === null) return;
        last = resumed.last;
        afterClose = resumed.afterClose;
        continue;
      }

      // Closing a sprint without having run QA is never accepted (R8).
      if (afterClose !== null) {
        const events = chats.allEventsAfter(chatId, afterClose.fromSeq);
        const closed = state.kind === 'scope' ? (state.sprint.closed ?? 0) : 0;
        if (closed > afterClose.closedBefore && !usedSkill(events, 'kyro-qa')) {
          this.stop(chat, {
            state: 'bloqueado',
            blockedReason: 'qa_sin_correr',
            detail: 'La sesión de cierre cerró el sprint sin correr kyro-qa',
          });
          return;
        }
        afterClose = null;
      }

      const decision = decideNextStep(state, run, last, { maxSessionsPerSprint: this.max });
      if (decision.kind === 'finished') {
        runs.finish(chatId);
        return;
      }
      if (decision.kind === 'stop') {
        this.stop(chat, decision);
        return;
      }

      let step: PromptStep;
      let findings: string[] = [];
      if (decision.kind === 'check_quality' && state.kind === 'scope') {
        const analysis = await kyro.analyze(cwd, state.scope);
        if (!analysis.ok) {
          this.stop(chat, {
            state: 'bloqueado',
            blockedReason: 'kyro_bloqueado',
            detail: `kyro analyze falló: ${analysis.error.message}`,
          });
          return;
        }
        const blocking = analysis.state.filter((f) => BLOCKING_SEVERITIES.has(f.severity));
        step = blocking.length > 0 ? 'fix' : 'close';
        findings = blocking.map((f) => `${f.severity} ${f.id} (${f.category}): ${f.detail}`);
      } else if (decision.kind === 'session') {
        step = decision.step;
      } else {
        return;
      }

      const task = await this.taskContext(chat, state);
      if (!task.ok) {
        this.stop(chat, {
          state: 'bloqueado',
          blockedReason: 'kyro_bloqueado',
          detail: task.error.message,
        });
        return;
      }
      const role = step === 'plan' ? 'thinker' : 'executor';
      const prompt = buildStepPrompt(step, { task: task.state, findings });
      const sprintN = state.kind === 'scope' ? state.sprint.current : null;
      const fromSeq = chats.lastSeq(chatId);
      const answeredBefore = questions.listByChat(chatId, 'answered').length;
      try {
        this.deps.manager.start(chatId, prompt, {
          role,
          freshSession: true,
          pilot: { step: step, policyVersion: POLICY_VERSION, sprintN },
        });
      } catch (error) {
        if (error instanceof SessionLimitError || error instanceof MaintenanceError) {
          this.queue(chat);
          return;
        }
        throw error;
      }
      runs.beginSession(chatId, {
        step: step,
        sprintN,
        fingerprint: fingerprint(state),
        policyVersion: POLICY_VERSION,
      });
      if (step === 'close' && state.kind === 'scope') {
        afterClose = { closedBefore: state.sprint.closed ?? 0, fromSeq };
      }

      const settled = await this.settle(chat, fromSeq, answeredBefore);
      if (settled === 'exit') return;
      last = settled;
      this.drainQueue();
    }
  }

  /** Waits for the session to end and reads how it ended; 'exit' when the loop must stop. */
  private async settle(
    chat: Chat,
    fromSeq: number,
    answeredBefore: number,
  ): Promise<LastSession | 'exit'> {
    const { chats, runs, manager, questions } = this.deps;
    await manager.waitForIdle(chat.id);
    const ended = chats.findById(chat.id);
    const events = chats.allEventsAfter(chat.id, fromSeq);
    if (hitUsageLimit(events)) {
      this.waitForQuota(chat);
      return 'exit';
    }
    if (ended?.status === 'cancelled') {
      // The user cancelled the turn: the pilot waits for them instead of opening the next step.
      runs.pause(chat.id);
      this.leave(chat, runs.get(chat.id));
      return 'exit';
    }
    if (ended?.status === 'error') {
      this.stop(chat, {
        state: 'bloqueado',
        blockedReason: 'otro',
        detail: 'La sesión del agente terminó con error',
      });
      return 'exit';
    }
    this.drainQueue();
    return {
      result: 'idle',
      answeredQuestion: questions.listByChat(chat.id, 'answered').length > answeredBefore,
    };
  }

  /**
   * After a restart: takes up again every run that was moving. A step that had an SDK session is
   * resumed with `resume` and a short continuation prompt (no message from the user); a run between
   * steps decides again from Kyro. Paused and switched-off runs stay as they are, and a run waiting
   * for the usage limit keeps its `retry_at`.
   */
  resumeAll(): void {
    const { runs, chats, sessions } = this.deps;
    const interrupted = new Map(
      chats
        .list()
        .map((chat) => [chat.id, sessions?.lastOpen(chat.id)] as const)
        .filter(([, open]) => open !== undefined),
    );
    // Nothing of the old process is still running: its open sessions ended with the restart.
    sessions?.closeOpen('interrupted');

    for (const run of runs.listByStatus('waiting_quota')) {
      const wait = Math.max(0, (run.retryAt ?? 0) - this.now());
      this.schedule(() => {
        try {
          runs.retryAfterQuota(run.chatId);
        } catch {
          return; // Paused or switched off while waiting.
        }
        this.kick(run.chatId);
      }, wait);
    }
    for (const run of runs.listByStatus('active')) {
      const open = interrupted.get(run.chatId);
      if (open !== undefined && open.step !== 'manual') {
        if (run.sessionsInSprint >= this.max) {
          const chat = chats.findById(run.chatId);
          if (chat) {
            this.stop(chat, {
              state: 'bloqueado',
              blockedReason: 'tope_de_sesiones',
              detail: `El sprint llegó al tope de ${String(this.max)} sesiones`,
            });
          }
          continue;
        }
        this.pendingResume.set(run.chatId, {
          role: open.role,
          step: open.step,
          sprintN: open.sprintN,
          policyVersion: open.policyVersion ?? POLICY_VERSION,
        });
      }
      this.kick(run.chatId);
    }
    this.drainQueue();
  }

  /** Reopens the interrupted step in its SDK session; null when the loop must stop. */
  private async resumeStep(
    chat: Chat,
    resume: PendingResume,
    state: KyroScopeState | KyroWorkState,
  ): Promise<{ last: LastSession; afterClose: AfterClose | null } | null> {
    const { chats, runs, manager, questions } = this.deps;
    const fromSeq = chats.lastSeq(chat.id);
    const answeredBefore = questions.listByChat(chat.id, 'answered').length;
    try {
      manager.start(chat.id, CONTINUE_PROMPT, {
        role: resume.role,
        pilot: {
          step: resume.step,
          policyVersion: resume.policyVersion,
          sprintN: resume.sprintN,
        },
      });
    } catch (error) {
      if (error instanceof SessionLimitError || error instanceof MaintenanceError) {
        this.queue(chat);
        this.pendingResume.set(chat.id, resume);
        return null;
      }
      throw error;
    }
    runs.countSession(chat.id);
    const settled = await this.settle(chat, fromSeq, answeredBefore);
    if (settled === 'exit') return null;
    // The QA check covers the whole step, so it counts from where the interrupted session began.
    const afterClose =
      resume.step === 'close' && state.kind === 'scope'
        ? { closedBefore: state.sprint.closed ?? 0, fromSeq: this.stepStartSeq(chat.id) }
        : null;
    return { last: settled, afterClose };
  }

  /** Seq just before the latest `session_started` event of the chat. */
  private stepStartSeq(chatId: number): number {
    const started = this.deps.chats
      .allEventsAfter(chatId, 0)
      .filter((event) => event.type === 'session_started');
    return Math.max(0, (started.at(-2)?.seq ?? 1) - 1);
  }

  private taskContext(
    chat: Chat,
    state: KyroScopeState | KyroWorkState,
  ): Promise<KyroReadResult<KyroTaskContext>> {
    return state.kind === 'scope'
      ? this.deps.kyro.contextPackTask(chat.worktreePath, state.scope)
      : this.deps.kyro.workContextPack(chat.worktreePath, state.work);
  }

  /** The pilot stops on purpose: the Timeline and the run both carry the reason. */
  private stop(
    chat: Chat,
    stop: {
      state: Parameters<WorktreeStateTracker['pilotMark']>[1]['state'];
      blockedReason: Parameters<WorktreeStateTracker['pilotMark']>[1]['blockedReason'];
      detail: string | null;
    },
  ): undefined {
    const reason = stop.detail ?? stop.blockedReason ?? stop.state;
    this.deps.tracker.pilotMark(chat, {
      state: stop.state,
      reason: `El piloto frenó: ${reason}`,
      detail: stop.detail,
      blockedReason: stop.blockedReason ?? null,
    });
    try {
      this.deps.runs.stop(chat.id, reason);
    } catch {
      // The run was paused or switched off at the same moment: that choice wins.
    }
    return undefined;
  }

  private queue(chat: Chat): undefined {
    this.deps.runs.queue(chat.id);
    this.deps.tracker.pilotMark(chat, {
      state: 'en_cola',
      reason: 'No hay sesiones libres: el trabajo espera en cola',
    });
    this.schedule(() => {
      this.drainQueue();
    }, QUEUE_RETRY_MS);
    return undefined;
  }

  private waitForQuota(chat: Chat): undefined {
    const retryAt = this.now() + QUOTA_RETRY_MS;
    this.deps.runs.waitForQuota(chat.id, retryAt);
    this.deps.tracker.pilotMark(chat, {
      state: 'sin_cupo_de_uso',
      reason: 'Se alcanzó el límite de uso: reintenta cada 15 minutos',
      data: { retryAt },
    });
    this.schedule(() => {
      try {
        this.deps.runs.retryAfterQuota(chat.id);
      } catch {
        return; // Paused or switched off while waiting.
      }
      this.kick(chat.id);
    }, QUOTA_RETRY_MS);
    return undefined;
  }

  /** The loop ended because the user paused or switched the pilot off. */
  private leave(chat: Chat, run: AutopilotRun | undefined): undefined {
    if (run?.status === 'paused') {
      this.deps.tracker.pilotMark(chat, { state: 'pausado', reason: 'Piloto en pausa' });
    }
    return undefined;
  }

  private crashed(chatId: number, error: unknown): void {
    const chat = this.deps.chats.findById(chatId);
    if (!chat) return;
    this.stop(chat, {
      state: 'bloqueado',
      blockedReason: 'otro',
      detail: error instanceof Error ? error.message : 'Falló el piloto',
    });
  }
}
