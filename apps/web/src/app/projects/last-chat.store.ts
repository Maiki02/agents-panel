import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { readLastChat, writeLastChat, type StorageLike } from './last-chat';

/** The browser's localStorage when it is usable, otherwise null (the app works without it). */
@Injectable({ providedIn: 'root' })
export class LastChatStore {
  private readonly storage: StorageLike | null = this.open();

  get(projectId: number): number | null {
    return readLastChat(this.storage, projectId);
  }

  set(projectId: number, chatId: number | null): void {
    writeLastChat(this.storage, projectId, chatId);
  }

  private open(): StorageLike | null {
    try {
      return inject(DOCUMENT).defaultView?.localStorage ?? null;
    } catch {
      return null;
    }
  }
}
