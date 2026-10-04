import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ProjectContext } from '../projects/project-context';
import { ChatSidebar } from './chat-sidebar';

/** The "Chats" section of a project: the chat list on the left and the conversation next to it. */
@Component({
  selector: 'app-chats-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, ChatSidebar],
  template: `
    @if (project(); as p) {
      <div class="grid gap-4 md:grid-cols-[16rem_minmax(0,1fr)]">
        <aside aria-label="Chats del proyecto">
          <app-chat-sidebar [projectId]="p.id" />
        </aside>
        <div class="min-w-0">
          <router-outlet />
        </div>
      </div>
    }
  `,
})
export class ChatsSection {
  protected readonly project = inject(ProjectContext).project;
}
