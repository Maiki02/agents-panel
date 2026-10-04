import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Chat } from '@agents-panel/shared';
import { ChatsService, apiErrorMessage } from './chats.service';
import { statusLabel } from './status';

/** Chats of one project (the API filters by projectId, so no other project's chat shows up). */
@Component({
  selector: 'app-chat-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink],
  template: `
    <h2>Chats</h2>
    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }
    @for (chat of chats(); track chat.id) {
      <article class="card chat-row">
        <a [routerLink]="['/chats', chat.id]">{{ chat.title }}</a>
        <div class="meta">
          {{ chat.kind === 'scope' ? 'scope' : 'work' }} · {{ chat.updatedAt | date: 'short' }}
          <span class="badge" [class]="'badge ' + chat.status">{{ label(chat) }}</span>
        </div>
      </article>
    } @empty {
      @if (loaded()) {
        <p class="hint">Todavía no hay chats en este proyecto.</p>
      }
    }
  `,
})
export class ChatList {
  private readonly service = inject(ChatsService);

  readonly projectId = input.required<number>();
  /** Bump to reload (for instance after creating a chat). */
  readonly reload = input(0);

  protected readonly chats = signal<Chat[]>([]);
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      this.reload();
      void this.load(this.projectId());
    });
  }

  protected label(chat: Chat): string {
    return statusLabel(chat.status);
  }

  private async load(projectId: number): Promise<void> {
    try {
      this.chats.set(await this.service.list(projectId));
      this.error.set(null);
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.loaded.set(true);
    }
  }
}
