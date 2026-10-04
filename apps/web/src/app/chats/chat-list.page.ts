import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Chat } from '@agents-panel/shared';
import { ChatsService, apiErrorMessage } from './chats.service';
import { NewChatForm } from './new-chat.form';
import { statusLabel } from './status';

@Component({
  selector: 'app-chat-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, NewChatForm],
  template: `
    <app-new-chat-form />
    <h2>Chats</h2>
    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }
    @for (chat of chats(); track chat.id) {
      <article class="card chat-row">
        <a [routerLink]="['/chats', chat.id]">{{ chat.title }}</a>
        <div class="meta">
          {{ chat.projectName }} · {{ chat.kind === 'scope' ? 'scope' : 'work' }} ·
          {{ chat.updatedAt | date: 'short' }}
          <span class="badge" [class]="'badge ' + chat.status">{{ label(chat) }}</span>
        </div>
      </article>
    } @empty {
      @if (loaded()) {
        <p class="hint">Todavía no hay chats.</p>
      }
    }
  `,
})
export class ChatListPage {
  private readonly service = inject(ChatsService);

  protected readonly chats = signal<Chat[]>([]);
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  protected label(chat: Chat): string {
    return statusLabel(chat.status);
  }

  private async load(): Promise<void> {
    try {
      this.chats.set(await this.service.list());
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.loaded.set(true);
    }
  }
}
