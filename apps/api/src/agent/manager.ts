import { randomUUID } from 'node:crypto';
import type {
  AutopilotStep,
  Chat,
  ChatStatus,
  ModelRole,
  PendingQuestion,
} from '@agents-panel/shared';
import type { ChatEventBus } from '../chats/events.js';
import {
  QuestionNotPendingError,
  parseAskedQuestions,
  toSdkAnswers,
  type QuestionRepository,
} from '../chats/questions-repo.js';
import type { ChatRepository } from '../chats/repo.js';
import type { AgentSessionRepository } from '../chats/sessions-repo.js';
import { observationFromRateLimitEvent, type UsageRepository } from '../usage/repo.js';
import type { TurnInfo, TurnObserver } from '../worktrees/state-tracker.js';
import { NO_BASH_EXTRAS, decide, type BashExtras } from './permissions.js';
import { ASK_USER_QUESTION, type AgentRunner, type PermissionDecision } from './runner.js';

export const MAX_CONCURRENT_SESSIONS = 4;

/** Extra data of a turn the pilot opens: the step it serves and the policy it was given. */
export interface PilotTurn {
  step: AutopilotStep;
  policyVersion: number;
  sprintN: number | null;
}

export interface StartOptions {
  role?: ModelRole;
  /** Set by the pilot; absent for a turn the user started. */
  pilot?: PilotTurn;
  /** Do not resume the chat's SDK session: the turn starts a new one. */
  freshSession?: boolean;
}

export class SessionLimitError extends Error {
  override readonly name = 'SessionLimitError';
}

export class AlreadyRunningError extends Error {
  override readonly name = 'AlreadyRunningError';
}

/** Thrown while a Kyro update runs: no new sessions may start (maps to HTTP 409). */
export class MaintenanceError extends Error {
  override readonly name = 'MaintenanceError';
  constructor() {
    super('Kyro se está actualizando; probá de nuevo cuando termine');
  }
}

export type MaintenanceStart =
  { ok: true } | { ok: false; running: number } | { ok: false; reason: 'maintenance' };

interface ActiveSession {
  controller: AbortController;
  done: Promise<void>;
}

/** The Claude account a turn runs with (see AccountService.activeForRun). */
export interface RunAccount {
  id: number;
  name: string;
  configDir: string | null;
}

/** A turn blocked inside AskUserQuestion until the user answers. */
interface QuestionWaiter {
  chatId: number;
  input: Record<string, unknown>;
  resolve: (decision: PermissionDecision) => void;
}

/** Model the SDK reports in its system:init message, if any. */
function initModel(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || !('model' in payload)) return undefined;
  return typeof payload.model === 'string' ? payload.model : undefined;
}

/** Runs one agent turn per chat in the background, persisting and publishing every event. */
export class AgentManager {
  private readonly active = new Map<number, ActiveSession>();
  private readonly waiters = new Map<number, QuestionWaiter>();
  private maintenance = false;

  /**
   * Without `questions` the agent cannot ask anything: AskUserQuestion is denied like any tool
   * outside the allowlist.
   */
  constructor(
    private readonly chats: ChatRepository,
    private readonly runner: AgentRunner,
    private readonly bus: ChatEventBus,
    private readonly maxConcurrent: number = MAX_CONCURRENT_SESSIONS,
    private readonly questions?: QuestionRepository,
    private readonly sessions?: AgentSessionRepository,
    private readonly observer?: TurnObserver,
    /** The project's extra Bash commands and curl hosts; read at the start of every turn. */
    private readonly bashExtras?: (projectId: number) => BashExtras,
    /** Claude account active when a turn starts; absent runs every turn with the default one. */
    private readonly accountOf?: () => RunAccount,
    /** Where each rate_limit_event is kept, per account; absent saves nothing. */
    private readonly usage?: UsageRepository,
  ) {}

  get runningCount(): number {
    return this.active.size;
  }

  get inMaintenance(): boolean {
    return this.maintenance;
  }

  /**
   * Blocks new sessions for a maintenance run, but only when none is running and no other run is
   * active. Check and flag happen in one synchronous tick, so no session can slip in between.
   */
  tryBeginMaintenance(): MaintenanceStart {
    if (this.maintenance) return { ok: false, reason: 'maintenance' };
    if (this.active.size > 0) return { ok: false, running: this.active.size };
    this.maintenance = true;
    return { ok: true };
  }

  endMaintenance(): void {
    this.maintenance = false;
  }

  hasCapacity(): boolean {
    return this.active.size < this.maxConcurrent;
  }

  isRunning(chatId: number): boolean {
    return this.active.has(chatId);
  }

  /** Resolves when the chat's current turn has finished (immediately if none is running). */
  async waitForIdle(chatId: number): Promise<void> {
    await this.active.get(chatId)?.done;
  }

  /**
   * Starts a turn for the chat. Continues the stored SDK session when there is one.
   * The turn runs with the chat's model for `role` (executor by default).
   * Throws AlreadyRunningError / SessionLimitError / MaintenanceError (all map to HTTP 409).
   */
  start(chatId: number, text: string, options: StartOptions = {}): void {
    if (this.maintenance) throw new MaintenanceError();
    const chat = this.chats.findById(chatId);
    if (!chat) throw new Error(`Chat not found: ${String(chatId)}`);
    if (this.active.has(chatId)) throw new AlreadyRunningError('Chat is already running');
    if (this.active.size >= this.maxConcurrent) {
      throw new SessionLimitError(`At most ${String(this.maxConcurrent)} sessions can run at once`);
    }

    const controller = new AbortController();
    this.chats.setStatus(chatId, 'running');
    this.record(chatId, 'user_prompt', { text });
    const role = options.role ?? 'executor';
    const model = chat.models[role];
    const pilot = options.pilot;
    // Read once per turn: switching the active account applies to the next turn, never mid-turn.
    const account = this.accountOf?.() ?? null;
    const sessionRowId =
      this.sessions?.open(
        chatId,
        role,
        chat.models.provider,
        model,
        pilot?.sprintN ?? null,
        { step: pilot?.step ?? 'manual', policyVersion: pilot?.policyVersion ?? null },
        account?.id ?? null,
      ) ?? null;
    this.record(chatId, 'session_started', {
      role,
      provider: chat.models.provider,
      model,
      ...(account ? { account: account.name } : {}),
      ...(pilot ? { step: pilot.step, policyVersion: pilot.policyVersion } : {}),
    });
    const turnInfo: TurnInfo = {
      role,
      model,
      ...(pilot ? { pilot: { step: pilot.step, policyVersion: pilot.policyVersion } } : {}),
    };
    this.observe(() => this.observer?.turnStarted(chat, turnInfo));

    const done = this.consume(
      chat,
      text,
      {
        ...turnInfo,
        sessionRowId,
        configDir: account?.configDir ?? null,
        accountId: account?.id ?? null,
      },
      controller,
      options.freshSession === true,
    ).finally(() => {
      this.active.delete(chatId);
    });
    this.active.set(chatId, { controller, done });
  }

  cancel(chatId: number): boolean {
    const session = this.active.get(chatId);
    if (!session) return false;
    session.controller.abort();
    return true;
  }

  /**
   * Gives the user's answer to the turn that is waiting on it, in the same SDK session. The answer
   * is only stored when a live turn can receive it: a question left over from before a restart is
   * cancelled instead (the resumed agent asks again). Throws the repository's QuestionErrors.
   */
  answerQuestion(questionId: number, answer: unknown, answeredBy: number): PendingQuestion {
    const questions = this.questions;
    if (!questions) throw new Error('Questions are not enabled');
    const waiter = this.waiters.get(questionId);
    if (!waiter) {
      const current = questions.get(questionId);
      if (current?.status === 'pending') {
        questions.cancelPending(current.chatId);
        this.record(current.chatId, 'question_cancelled', { questionId });
        throw new QuestionNotPendingError(questionId, 'cancelled');
      }
    }
    const answered = questions.answer(questionId, answer, answeredBy);
    const answeredChat = this.chats.findById(answered.chatId);
    if (answeredChat) this.observe(() => this.observer?.questionAnswered(answeredChat));
    this.record(answered.chatId, 'question_answered', {
      questionId,
      answer: answered.answer,
      answeredBy,
    });
    if (waiter && answered.answer) {
      this.waiters.delete(questionId);
      waiter.resolve({
        behavior: 'allow',
        updatedInput: { ...waiter.input, answers: toSdkAnswers(answered.answer) },
      });
    }
    return answered;
  }

  /**
   * AskUserQuestion: stores the question, tells the web and waits with no timeout until the user
   * answers (answerQuestion) or the turn is aborted. Nothing here ever answers on the user's behalf.
   */
  private askUser(
    chatId: number,
    input: Record<string, unknown>,
    toolUseId: string | undefined,
    signal: AbortSignal,
  ): Promise<PermissionDecision> {
    const questions = this.questions;
    if (!questions) {
      return Promise.resolve({ behavior: 'deny', message: 'Tool not allowed: AskUserQuestion' });
    }
    let pending: PendingQuestion;
    try {
      pending = questions.create(chatId, toolUseId ?? randomUUID(), parseAskedQuestions(input));
    } catch (error) {
      return Promise.resolve({
        behavior: 'deny',
        message: error instanceof Error ? error.message : 'Invalid question',
      });
    }
    this.record(chatId, 'question_asked', {
      questionId: pending.id,
      toolUseId: pending.toolUseId,
      questions: pending.questions,
    });
    const askingChat = this.chats.findById(chatId);
    if (askingChat) this.observe(() => this.observer?.questionAsked(askingChat));
    return new Promise<PermissionDecision>((resolve) => {
      const cancel = () => {
        if (this.waiters.delete(pending.id)) {
          questions.cancelPending(chatId);
          this.record(chatId, 'question_cancelled', { questionId: pending.id });
          resolve({ behavior: 'deny', message: 'The question was cancelled' });
        }
      };
      this.waiters.set(pending.id, { chatId, input, resolve });
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    });
  }

  private record(chatId: number, type: string, payload: unknown): void {
    this.bus.publish(this.chats.appendEvent(chatId, type, payload));
  }

  private async consume(
    chat: Chat,
    prompt: string,
    turn: TurnInfo & {
      sessionRowId: number | null;
      configDir: string | null;
      accountId: number | null;
    },
    controller: AbortController,
    freshSession: boolean,
  ): Promise<void> {
    const chatId = chat.id;
    const cwd = chat.worktreePath;
    // Loaded per turn so a change in the project's permissions applies to the next turn.
    const bashExtras = this.bashExtras?.(chat.projectId) ?? NO_BASH_EXTRAS;
    let final: ChatStatus = 'idle';
    try {
      const events = this.runner.run({
        cwd,
        prompt,
        model: turn.model,
        role: turn.role,
        configDir: turn.configDir,
        // A pilot step opens a new SDK session instead of continuing the previous one.
        ...(chat.sdkSessionId && !freshSession ? { resumeSessionId: chat.sdkSessionId } : {}),
        signal: controller.signal,
        canUseTool: (toolName, input, context) => {
          if (toolName === ASK_USER_QUESTION && this.questions) {
            return this.askUser(chatId, input, context?.toolUseId, controller.signal);
          }
          const decision = decide({ cwd, bashExtras }, toolName, input);
          if (decision.behavior === 'deny') {
            this.record(chatId, 'permission_denied', {
              tool: toolName,
              input,
              reason: decision.message,
            });
          }
          return Promise.resolve(decision);
        },
      });
      for await (const event of events) {
        if (event.sessionId) {
          this.chats.setSessionId(chatId, event.sessionId);
          if (turn.sessionRowId !== null) {
            this.sessions?.setSdkSessionId(turn.sessionRowId, event.sessionId);
          }
        }
        this.record(chatId, event.type, event.payload);
        if (event.type === 'rate_limit_event') this.saveUsage(turn.accountId, event.payload);
        const reported = event.type === 'system:init' ? initModel(event.payload) : undefined;
        if (reported !== undefined && reported !== turn.model) {
          this.record(chatId, 'model_mismatch', { requested: turn.model, reported });
        }
        if (event.type.startsWith('result:') && event.type !== 'result:success') final = 'error';
      }
      if (controller.signal.aborted) final = 'cancelled';
    } catch (error) {
      if (controller.signal.aborted) {
        final = 'cancelled';
      } else {
        final = 'error';
        this.record(chatId, 'error', {
          message: error instanceof Error ? error.message : 'Agent session failed',
        });
      }
    }
    // A turn that ends cannot receive an answer anymore: drop its waiters (denying them so nothing
    // stays suspended) and cancel the stored questions, each one with its event.
    this.questions?.cancelPending(chatId);
    this.dropWaiters(chatId);
    if (turn.sessionRowId !== null) this.sessions?.close(turn.sessionRowId, final);
    this.chats.setStatus(chatId, final);
    const finished = this.chats.findById(chatId);
    if (finished && this.observer) {
      try {
        await this.observer.turnFinished(
          finished,
          { role: turn.role, model: turn.model, ...(turn.pilot ? { pilot: turn.pilot } : {}) },
          final,
        );
      } catch {
        // The state is a view of the work: failing to update it must not break the chat.
      }
    }
  }

  /** Resolves with deny and forgets every question this chat's ended turn was still waiting on. */
  private dropWaiters(chatId: number): void {
    for (const [questionId, waiter] of [...this.waiters]) {
      if (waiter.chatId !== chatId) continue;
      this.waiters.delete(questionId);
      this.record(chatId, 'question_cancelled', { questionId });
      waiter.resolve({
        behavior: 'deny',
        message: 'The turn ended before the question was answered',
      });
    }
  }

  /** Keeps the window of a rate_limit_event for the turn's account; a failure never breaks the turn. */
  private saveUsage(accountId: number | null, payload: unknown): void {
    if (!this.usage || accountId === null) return;
    try {
      const observation = observationFromRateLimitEvent(payload);
      if (observation) this.usage.upsert(accountId, observation);
    } catch {
      // Usage is a passive reading: losing one observation is better than losing the turn.
    }
  }

  /** Runs a state-tracking hook; it can never break a turn. */
  private observe(action: () => void): void {
    try {
      action();
    } catch {
      // See turnFinished above.
    }
  }
}
