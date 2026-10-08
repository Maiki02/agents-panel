import { Injectable, signal } from '@angular/core';
import type { ChatKind } from '@agents-panel/shared';

/**
 * What is typed in the "Nuevo chat" dialog. The dialog is destroyed when it closes, so the draft
 * lives here: closing it (Esc, X, backdrop) keeps the text until the page is reloaded, the chat
 * is created, or another project's form opens.
 */
@Injectable({ providedIn: 'root' })
export class NewChatDraft {
  readonly kind = signal<ChatKind>('work');
  readonly slug = signal('');
  readonly prompt = signal('');
  /** The switch starts on; only a scope or work can have it. */
  readonly autopilot = signal(true);
  /** null: the project's model stays (the select shows it as the default). */
  readonly thinker = signal<string | null>(null);
  readonly executor = signal<string | null>(null);
  private projectId: number | null = null;

  /** Opens the draft of a project; the one of another project is dropped. */
  use(projectId: number): void {
    if (this.projectId !== projectId) this.reset();
    this.projectId = projectId;
  }

  reset(): void {
    this.kind.set('work');
    this.slug.set('');
    this.prompt.set('');
    this.autopilot.set(true);
    this.thinker.set(null);
    this.executor.set(null);
  }
}
