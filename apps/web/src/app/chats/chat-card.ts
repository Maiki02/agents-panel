import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import type { Chat } from '@agents-panel/shared';
import { Badge } from '../ui/badge';
import { chatSubtitle, kindChipLabel, sidebarBadge } from './status';

/**
 * Card of a chat (worktree). The whole card links to the chat and is marked when it is the open
 * one or has focus. Title = short name (slug); the one state badge on the right; below, the kind
 * as a neutral chip (not a state) and the branch.
 */
@Component({
  selector: 'app-chat-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, Badge],
  template: `
    <a
      [routerLink]="['/projects', projectId(), 'chats', chat().id]"
      routerLinkActive="!border-accent bg-surface-raised"
      class="block h-full rounded-control border border-border bg-surface px-3 py-2 text-text hover:bg-surface-raised hover:no-underline focus-visible:border-accent focus-visible:bg-surface-raised"
    >
      <span class="flex items-start justify-between gap-2">
        <span class="min-w-0 break-words text-sm font-medium">{{ chat().slug }}</span>
        <app-badge class="shrink-0" [tone]="badge().tone">{{ badge().label }}</app-badge>
      </span>
      <span class="mt-1 flex items-center gap-2">
        <span class="kind-chip">{{ kindLabel() }}</span>
        <span class="min-w-0 break-all text-xs text-muted">{{ subtitle() }}</span>
      </span>
    </a>
  `,
})
export class ChatCard {
  readonly chat = input.required<Chat>();
  readonly projectId = input.required<number>();

  protected badge() {
    return sidebarBadge(this.chat());
  }
  protected kindLabel(): string {
    return kindChipLabel(this.chat().kind);
  }
  protected subtitle(): string {
    return chatSubtitle(this.chat());
  }
}
