import type { ChatStatus } from '@agents-panel/shared';
import type { ChatEventBus } from '../chats/events.js';
import type { ChatRepository } from '../chats/repo.js';
import { decide } from './permissions.js';
import type { AgentRunner } from './runner.js';

export const MAX_CONCURRENT_SESSIONS = 4;

export class SessionLimitError extends Error {
  override readonly name = 'SessionLimitError';
}

export class AlreadyRunningError extends Error {
  override readonly name = 'AlreadyRunningError';
}

interface ActiveSession {
  controller: AbortController;
  done: Promise<void>;
}

/** Runs one agent turn per chat in the background, persisting and publishing every event. */
export class AgentManager {
  private readonly active = new Map<number, ActiveSession>();

  constructor(
    private readonly chats: ChatRepository,
    private readonly runner: AgentRunner,
    private readonly bus: ChatEventBus,
    private readonly maxConcurrent: number = MAX_CONCURRENT_SESSIONS,
  ) {}

  get runningCount(): number {
    return this.active.size;
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
   * Throws AlreadyRunningError / SessionLimitError (both map to HTTP 409).
   */
  start(chatId: number, text: string): void {
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
        canUseTool: (toolName, input) => {
          const decision = decide({ cwd }, toolName, input);
          if (decision.behavior === 'deny') {
            this.record(chatId, 'permission_denied', {
              tool: toolName,
              input,
              reason: decision.message,
            });
          }
          return decision;
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
    this.chats.setStatus(chatId, final);
  }
}
