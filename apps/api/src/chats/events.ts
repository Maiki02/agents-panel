import { EventEmitter } from 'node:events';
import type { ChatEvent } from '@agents-panel/shared';

const ALL = 'all';

/** In-process fan-out of persisted chat events; SSE listeners subscribe per chat. */
export class ChatEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: ChatEvent): void {
    this.emitter.emit(this.channel(event.chatId), event);
    this.emitter.emit(ALL, event);
  }

  /** Every event of every chat (the push notifier); returns the unsubscribe function. */
  subscribeAll(listener: (event: ChatEvent) => void): () => void {
    this.emitter.on(ALL, listener);
    return () => {
      this.emitter.off(ALL, listener);
    };
  }

  subscribe(chatId: number, listener: (event: ChatEvent) => void): () => void {
    const channel = this.channel(chatId);
    this.emitter.on(channel, listener);
    return () => {
      this.emitter.off(channel, listener);
    };
  }

  listenerCount(chatId: number): number {
    return this.emitter.listenerCount(this.channel(chatId));
  }

  private channel(chatId: number): string {
    return `chat:${String(chatId)}`;
  }
}
