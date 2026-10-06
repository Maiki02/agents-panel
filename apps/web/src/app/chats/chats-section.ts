import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ProjectContext } from '../projects/project-context';
import { currentUrl } from '../shell/current-url';
import { WIDE_QUERY, mediaMatches } from '../shell/media';
import { Button } from '../ui/button';
import { Drawer } from '../ui/drawer';
import { closesOnNavigation } from '../ui/drawer-logic';
import { Icon } from '../ui/icon';
import { ChatSidebar } from './chat-sidebar';

/**
 * The "Chats" section of a project, filling the height it gets. Wide screens: the chat list on
 * the left (own scroll) and the conversation next to it. Phones: the conversation takes it all
 * and a "Chats" button opens the list as a sliding panel, which closes when a chat is picked.
 * Only one list is mounted at a time (each one polls while an agent runs).
 */
@Component({
  selector: 'app-chats-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, ChatSidebar, Drawer, Button, Icon],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    @if (project(); as p) {
      <div class="flex min-h-0 flex-1 gap-4">
        @if (wide()) {
          <aside class="w-64 shrink-0 overflow-y-auto pr-1" aria-label="Chats del proyecto">
            <app-chat-sidebar [projectId]="p.id" />
          </aside>
        }
        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
          @if (!wide()) {
            <div class="mb-2 shrink-0">
              <button
                appButton
                variant="secondary"
                type="button"
                [attr.aria-expanded]="listOpen()"
                (click)="listOpen.set(true)"
              >
                <app-icon name="chats" />
                Chats
              </button>
            </div>
          }
          <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <router-outlet />
          </div>
        </div>
      </div>
      @if (!wide()) {
        <app-drawer [open]="listOpen()" heading="Chats del proyecto" (closed)="listOpen.set(false)">
          <app-chat-sidebar [projectId]="p.id" />
        </app-drawer>
      }
    }
  `,
})
export class ChatsSection {
  protected readonly project = inject(ProjectContext).project;
  protected readonly wide = mediaMatches(WIDE_QUERY);
  protected readonly listOpen = signal(false);
  private readonly url = currentUrl();

  constructor() {
    // Picking a chat (or "Nuevo chat") navigates: the panel gets out of the way.
    let previous = this.url();
    effect(() => {
      const next = this.url();
      if (closesOnNavigation(previous, next)) this.listOpen.set(false);
      previous = next;
    });
  }
}
