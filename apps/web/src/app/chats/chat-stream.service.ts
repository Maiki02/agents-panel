import { Injectable } from '@angular/core';
import type { ChatEvent } from '@agents-panel/shared';

export interface StreamHandle {
  close(): void;
}

/** Thin wrapper over EventSource (same-origin, so the session cookie goes along). */
@Injectable({ providedIn: 'root' })
export class ChatStreamService {
  /**
   * Streams events after `afterSeq`. EventSource reconnects by itself and replays from the
   * last id it saw (Last-Event-ID), so the server never repeats or skips an event.
   */
  open(
    chatId: number,
    afterSeq: number,
    handlers: {
      onEvent: (event: ChatEvent) => void;
      onConnection: (connected: boolean) => void;
    },
  ): StreamHandle {
    const source = new EventSource(
      `/api/chats/${String(chatId)}/stream?afterSeq=${String(afterSeq)}`,
    );
    source.onopen = () => {
      handlers.onConnection(true);
    };
    source.onerror = () => {
      handlers.onConnection(false);
    };
    source.onmessage = (message: MessageEvent<string>) => {
      handlers.onEvent(JSON.parse(message.data) as ChatEvent);
    };
    return {
      close: () => {
        source.close();
      },
    };
  }
}
