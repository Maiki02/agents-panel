import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ProjectContext } from '../projects/project-context';
import { NewChatForm } from './new-chat.form';

/** chats/new: the new-chat form of the open project (the project is fixed, never chosen). */
@Component({
  selector: 'app-new-chat-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NewChatForm],
  template: `
    @if (project(); as p) {
      <app-new-chat-form [project]="p" />
    }
  `,
})
export class NewChatPage {
  protected readonly project = inject(ProjectContext).project;
}
