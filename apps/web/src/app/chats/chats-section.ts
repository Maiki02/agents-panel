import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import type { Chat } from '@agents-panel/shared';
import { ProjectContext } from '../projects/project-context';
import { currentUrl } from '../shell/current-url';
import { Button } from '../ui/button';
import { Icon } from '../ui/icon';
import { Modal } from '../ui/modal';
import { ChatList } from './chat-list';
import { NewChatForm } from './new-chat.form';

/** chats/new (also the old "Nuevo chat" links) is the grid with the dialog open. */
const NEW_CHAT_URL = /\/chats\/new(?:[/?#]|$)/;

/**
 * The "Chats" section of a project: "Nuevo chat" on top, the filters and the grid of chat cards
 * below. "Nuevo chat" opens a dialog (route chats/new); creating closes it and opens the chat.
 * Closing it any other way keeps what was typed (NewChatDraft) until the page is reloaded.
 */
@Component({
  selector: 'app-chats-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Button, Icon, Modal, ChatList, NewChatForm],
  host: { class: 'block' },
  template: `
    @if (project(); as p) {
      <div class="mb-3 flex items-center justify-between gap-3">
        <h2 class="m-0 text-lg font-semibold">Chats</h2>
        <button appButton variant="primary" type="button" (click)="openNew(p.id)">
          <app-icon name="plus" />
          Nuevo chat
        </button>
      </div>
      <app-chat-list [projectId]="p.id" />
      @if (newOpen()) {
        <app-modal heading="Nuevo chat" [wide]="true" (closed)="closeNew(p.id)">
          <app-new-chat-form [project]="p" (created)="opened($event)" />
        </app-modal>
      }
    }
  `,
})
export class ChatsSection {
  private readonly router = inject(Router);
  protected readonly project = inject(ProjectContext).project;
  private readonly url = currentUrl();
  protected readonly newOpen = computed(() => NEW_CHAT_URL.test(this.url()));

  protected openNew(projectId: number): void {
    void this.router.navigate(['/projects', projectId, 'chats', 'new']);
  }

  protected closeNew(projectId: number): void {
    void this.router.navigate(['/projects', projectId, 'chats']);
  }

  /** A chat was created: the dialog goes away with the navigation to the chat. */
  protected opened(chat: Chat): void {
    void this.router.navigate(['/projects', chat.projectId, 'chats', chat.id]);
  }
}
