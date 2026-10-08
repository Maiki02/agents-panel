import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import type { Chat } from '@agents-panel/shared';
import {
  CHAT_FILTERS,
  emptyFilterText,
  filterChats,
  filterCounts,
  loadChatFilter,
  saveChatFilter,
  type ChatFilterId,
} from './chat-filter-logic';
import { ChatsService, apiErrorMessage } from './chats.service';
import { ChatCard } from './chat-card';
import { hasRunning } from './status';

const POLL_MS = 4000;

/**
 * The project's chats as a grid of cards (one column on phones, two from `sm`, three from `xl`)
 * under the status filters. The API filters by projectId, so no other project's chat shows up.
 * It loads on open and reloads every few seconds only while some agent is running.
 */
@Component({
  selector: 'app-chat-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChatCard],
  template: `
    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }
    <div class="mb-3 flex flex-wrap gap-1" role="group" aria-label="Filtrar chats">
      @for (option of filters; track option.id) {
        <button
          type="button"
          class="rounded-pill border px-2 py-0.5 text-xs font-medium transition-colors"
          [class]="
            filter() === option.id
              ? 'border-accent bg-surface-raised text-text'
              : 'border-border text-muted hover:bg-surface-raised hover:text-text'
          "
          [attr.aria-pressed]="filter() === option.id"
          (click)="choose(option.id)"
        >
          {{ option.label }} {{ counts()[option.id] }}
        </button>
      }
    </div>
    @if (visible().length > 0) {
      <ul class="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3">
        @for (chat of visible(); track chat.id) {
          <li class="min-w-0">
            <app-chat-card [chat]="chat" [projectId]="projectId()" />
          </li>
        }
      </ul>
    } @else if (loaded()) {
      <p class="hint" data-testid="chats-empty">{{ emptyText() }}</p>
    } @else {
      <p class="hint" role="status">Cargando…</p>
    }
  `,
})
export class ChatList {
  private readonly service = inject(ChatsService);

  readonly projectId = input.required<number>();

  protected readonly chats = signal<Chat[]>([]);
  protected readonly loaded = signal(false);
  /** The project the shown chats belong to (the cached list is painted per project). */
  private shown: number | undefined;
  protected readonly error = signal<string | null>(null);
  private timer: ReturnType<typeof setInterval> | undefined;

  protected readonly filters = CHAT_FILTERS;
  protected readonly filter = signal<ChatFilterId>(
    loadChatFilter(typeof localStorage === 'undefined' ? undefined : localStorage),
  );
  protected readonly visible = computed(() => filterChats(this.chats(), this.filter()));
  protected readonly counts = computed(() => filterCounts(this.chats()));
  protected readonly emptyText = computed(() => emptyFilterText(this.filter()));

  constructor() {
    effect(() => {
      void this.reload(this.projectId());
    });
    inject(DestroyRef).onDestroy(() => {
      this.stopPolling();
    });
  }

  protected choose(filter: ChatFilterId): void {
    this.filter.set(filter);
    saveChatFilter(typeof localStorage === 'undefined' ? undefined : localStorage, filter);
  }

  private async reload(projectId: number): Promise<void> {
    if (this.shown !== projectId) {
      // Another project (or the first load): paint what the service already knows, or nothing.
      this.shown = projectId;
      const known = this.service.cachedList(projectId);
      this.chats.set(known ?? []);
      this.loaded.set(known !== undefined);
    }
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
