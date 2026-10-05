import { randomUUID } from 'node:crypto';
import type { ChatStatus, PendingQuestion } from '@agents-panel/shared';
import type { ChatEventBus } from '../chats/events.js';
import {
  QuestionNotPendingError,
  parseAskedQuestions,
  toSdkAnswers,
  type QuestionRepository,
} from '../chats/questions-repo.js';
import type { ChatRepository } from '../chats/repo.js';
import { decide } from './permissions.js';
import { ASK_USER_QUESTION, type AgentRunner, type PermissionDecision } from './runner.js';

export const MAX_CONCURRENT_SESSIONS = 4;

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

/** A turn blocked inside AskUserQuestion until the user answers. */
interface QuestionWaiter {
  chatId: number;
  input: Record<string, unknown>;
  resolve: (decision: PermissionDecision) => void;
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
   * Throws AlreadyRunningError / SessionLimitError / MaintenanceError (all map to HTTP 409).
   */
  start(chatId: number, text: string): void {
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

    const done = this.consume(
      chatId,
      chat.worktreePath,
      text,
      chat.sdkSessionId,
      controller,
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
    chatId: number,
    cwd: string,
    prompt: string,
    resumeSessionId: string | null,
    controller: AbortController,
  ): Promise<void> {
    let final: ChatStatus = 'idle';
    try {
      const events = this.runner.run({
        cwd,
        prompt,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        signal: controller.signal,
        canUseTool: (toolName, input, context) => {
          if (toolName === ASK_USER_QUESTION && this.questions) {
            return this.askUser(chatId, input, context?.toolUseId, controller.signal);
          }
          const decision = decide({ cwd }, toolName, input);
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
        if (event.sessionId) this.chats.setSessionId(chatId, event.sessionId);
        this.record(chatId, event.type, event.payload);
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
    // A turn that ends cannot receive an answer anymore.
    this.questions?.cancelPending(chatId);
    this.chats.setStatus(chatId, final);
  }
}
