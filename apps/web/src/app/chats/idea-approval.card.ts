import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { IdeaAction, IdeaDocument } from '@agents-panel/shared';
import { Button } from '../ui/button';
import { IDEA_ACTION_LABEL, ideaActionStates, parseMarkdown, type MdBlock } from './approval-logic';
import { ChatsService, apiErrorMessage } from './chats.service';

/**
 * The plan of an idea and the three decisions about it: approve it as a scope, as a work, or ask
 * for changes. The Markdown comes from the repo, so it is shown as data (no raw HTML).
 */
@Component({
  selector: 'app-idea-approval-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Button, NgTemplateOutlet],
  template: `
    <section class="card approval" aria-label="Plan de la idea">
      <h2>Plan listo para aprobar</h2>
      @if (document(); as doc) {
        @if (doc.path) {
          <p class="hint">{{ doc.path }}</p>
        }
        @if (doc.truncated) {
          <p class="hint">El documento es largo: se muestra solo el principio.</p>
        }
        <div class="plan" data-testid="plan">
          @for (block of blocks(); track $index) {
            @switch (block.kind) {
              @case ('heading') {
                <p class="plan-heading" [attr.data-level]="block.level">
                  <ng-container
                    *ngTemplateOutlet="inlineTpl; context: { $implicit: block.inline }"
                  />
                </p>
              }
              @case ('paragraph') {
                <p>
                  <ng-container
                    *ngTemplateOutlet="inlineTpl; context: { $implicit: block.inline }"
                  />
                </p>
              }
              @case ('quote') {
                <blockquote>
                  <ng-container
                    *ngTemplateOutlet="inlineTpl; context: { $implicit: block.inline }"
                  />
                </blockquote>
              }
              @case ('list') {
                <ul>
                  @for (item of block.items; track $index) {
                    <li>
                      <ng-container *ngTemplateOutlet="inlineTpl; context: { $implicit: item }" />
                    </li>
                  }
                </ul>
              }
              @case ('code') {
                <pre>{{ block.text }}</pre>
              }
              @case ('rule') {
                <hr />
              }
            }
          }
        </div>
      } @else if (loadError(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      } @else {
        <p class="hint">Cargando el plan…</p>
      }

      <label for="changes">Qué cambiar (obligatorio para pedir cambios)</label>
      <textarea
        id="changes"
        rows="3"
        [disabled]="busy()"
        [value]="changes()"
        (input)="changes.set(text($event))"
      ></textarea>

      <div class="approval-actions">
        @for (action of actions; track action) {
          <button
            appButton
            type="button"
            [variant]="action === 'request_changes' ? 'secondary' : 'primary'"
            [disabled]="states()[action].disabled"
            [title]="states()[action].reason ?? ''"
            (click)="send(action)"
          >
            {{ labels[action] }}
          </button>
        }
      </div>
      @if (reason(); as why) {
        <p class="hint" role="status">{{ why }}</p>
      }
      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
    </section>

    <ng-template #inlineTpl let-parts>
      @for (part of parts; track $index) {
        @switch (part.kind) {
          @case ('code') {
            <code>{{ part.text }}</code>
          }
          @case ('strong') {
            <strong>{{ part.text }}</strong>
          }
          @case ('em') {
            <em>{{ part.text }}</em>
          }
          @default {
            {{ part.text }}
          }
        }
      }
    </ng-template>
  `,
})
export class IdeaApprovalCard {
  private readonly service = inject(ChatsService);

  readonly chatId = input.required<number>();
  /** The decision went through: the page reads the new state of the chat. */
  readonly decided = output();

  protected readonly actions: readonly IdeaAction[] = [
    'approve_scope',
    'approve_work',
    'request_changes',
  ];
  protected readonly labels = IDEA_ACTION_LABEL;
  protected readonly document = signal<IdeaDocument | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly changes = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly blocks = computed<MdBlock[]>(() =>
    parseMarkdown(this.document()?.content ?? ''),
  );
  protected readonly states = computed(() =>
    ideaActionStates({ document: this.document(), changes: this.changes(), busy: this.busy() }),
  );
  /** Why the main action is off, shown once under the buttons. */
  protected readonly reason = computed(() => {
    const states = this.states();
    return states.approve_scope.reason ?? states.request_changes.reason ?? null;
  });

  constructor() {
    effect(() => {
      void this.load(this.chatId());
    });
  }

  protected text(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }

  private async load(id: number): Promise<void> {
    this.document.set(null);
    this.loadError.set(null);
    try {
      this.document.set(await this.service.idea(id));
    } catch (cause) {
      this.loadError.set(apiErrorMessage(cause));
    }
  }

  protected async send(action: IdeaAction): Promise<void> {
    if (this.states()[action].disabled) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.service.ideaAction(
        this.chatId(),
        action === 'request_changes' ? { action, text: this.changes().trim() } : { action },
      );
      this.changes.set('');
      this.decided.emit();
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.busy.set(false);
    }
  }
}
