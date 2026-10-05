import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import type { Chat } from '@agents-panel/shared';
import { filter } from 'rxjs';
import { Badge } from '../ui/badge';
import { Icon } from '../ui/icon';
import { ChatsService, apiErrorMessage } from './chats.service';
import { chatSubtitle, hasRunning, sidebarBadge } from './status';

const POLL_MS = 4000;

/**
 * Left column of the Chats section, like current AI chat apps: "Nuevo chat" on top and the
 * project's chats below (title, kind and branch, status). The API filters by projectId, so no
 * other project's chat shows up. It reloads after every navigation (a created chat appears and
 * gets selected) and every few seconds while some agent is running.
 */
@Component({
  selector: 'app-chat-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, Badge, Icon],
  template: `
    <a
      [routerLink]="['/projects', projectId(), 'chats', 'new']"
      routerLinkActive="!bg-surface-raised"
      class="mb-2 flex items-center gap-2 rounded-control border border-border px-3 py-2 text-sm font-medium text-text hover:bg-surface-raised hover:no-underline"
    >
      <app-icon name="plus" />
      Nuevo chat
    </a>
    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }
    <ul class="m-0 flex list-none flex-col gap-1 p-0">
      @for (chat of chats(); track chat.id) {
        <li>
          <a
            [routerLink]="['/projects', projectId(), 'chats', chat.id]"
            routerLinkActive="!border-accent bg-surface-raised"
            class="block rounded-control border border-transparent px-3 py-2 text-text hover:bg-surface-raised hover:no-underline"
          >
            <span class="flex items-start justify-between gap-2">
              <span class="min-w-0 break-words text-sm font-medium">{{ chat.title }}</span>
              <app-badge class="shrink-0" [tone]="badge(chat).tone">
                {{ badge(chat).label }}
              </app-badge>
            </span>
            <span class="mt-0.5 block break-all text-xs text-muted">{{ subtitle(chat) }}</span>
          </a>
        </li>
      } @empty {
        @if (loaded()) {
          <li class="hint px-1">Todavía no hay chats en este proyecto.</li>
        }
      }
    </ul>
  `,
})
export class ChatSidebar {
  private readonly service = inject(ChatsService);

  readonly projectId = input.required<number>();

  protected readonly chats = signal<Chat[]>([]);
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);
  private timer: ReturnType<typeof setInterval> | undefined;

  protected readonly badge = sidebarBadge;
  protected readonly subtitle = chatSubtitle;

  constructor() {
    effect(() => {
      void this.reload(this.projectId());
    });
    inject(Router)
      .events.pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        void this.reload(this.projectId());
      });
    inject(DestroyRef).onDestroy(() => {
      this.stopPolling();
    });
  }

  private async reload(projectId: number): Promise<void> {
    try {
      const chats = await this.service.list(projectId);
      if (projectId !== this.projectId()) return;
      this.chats.set(chats);
      this.error.set(null);
      this.syncPolling(projectId, hasRunning(chats));
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.loaded.set(true);
    }
  }

  /** Keeps a timer only while some chat is running; stops as soon as none is (and on destroy). */
  private syncPolling(projectId: number, running: boolean): void {
    if (running) {
      this.timer ??= setInterval(() => void this.reload(projectId), POLL_MS);
    } else {
      this.stopPolling();
    }
  }

  private stopPolling(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
