import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { AskedQuestion, QuestionAnswer } from '@agents-panel/shared';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  buildAnswerBody,
  emptyDraft,
  incompleteReason,
  setText,
  toggleOption,
  type AnswerDraft,
} from './question-logic';

/**
 * The agent's pending question: one button per option (several when the question allows it) plus
 * "Otra respuesta" for free text. The card only builds the answer; the page sends it.
 */
@Component({
  selector: 'app-question-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Button, Badge],
  template: `
    <form class="card question" (submit)="submit($event)" aria-label="Pregunta del agente">
      @for (q of questions(); track q.question) {
        <fieldset class="question-item" [disabled]="busy()">
          <legend class="question-title">
            <app-badge tone="warn">{{ q.header }}</app-badge>
            {{ q.question }}
          </legend>
          @if (q.multiSelect) {
            <p class="hint">Podés elegir más de una.</p>
          }
          <div class="question-options">
            @for (option of q.options; track option.label) {
              <button
                appButton
                type="button"
                [variant]="isSelected(q, option.label) ? 'primary' : 'secondary'"
                [attr.aria-pressed]="isSelected(q, option.label)"
                [title]="option.description"
                (click)="pick(q, option.label)"
              >
                {{ option.label }}
              </button>
            }
          </div>
          <label [for]="textId($index)">Otra respuesta</label>
          <input
            [id]="textId($index)"
            autocomplete="off"
            maxlength="2000"
            [value]="current()[q.question]?.text ?? ''"
            (input)="type(q, $event)"
          />
        </fieldset>
      }
      <div class="question-actions">
        <button appButton type="submit" [disabled]="busy() || reason() !== null">
          {{ busy() ? 'Enviando…' : 'Enviar' }}
        </button>
        @if (busy()) {
          <span class="hint" role="status">Enviando tu respuesta…</span>
        } @else if (reason(); as why) {
          <span class="hint" role="status">{{ why }}</span>
        }
      </div>
    </form>
  `,
})
export class QuestionCard {
  readonly questions = input.required<readonly AskedQuestion[]>();
  /** True from the moment the answer is sent until the server confirms it. */
  readonly busy = input(false);
  readonly answered = output<{ answer: QuestionAnswer }>();

  /** Drafts are created for the questions of the first render; a card never changes its questions. */
  protected readonly draft = signal<AnswerDraft | null>(null);
  protected readonly current = computed<AnswerDraft>(
    () => this.draft() ?? emptyDraft(this.questions()),
  );
  protected readonly reason = computed(() => incompleteReason(this.questions(), this.current()));

  protected isSelected(question: AskedQuestion, label: string): boolean {
    return this.current()[question.question]?.selected.includes(label) ?? false;
  }

  protected textId(index: number): string {
    return `question-text-${String(index)}`;
  }

  protected pick(question: AskedQuestion, label: string): void {
    const draft = this.current();
    const item = draft[question.question] ?? { selected: [], text: '' };
    this.draft.set({ ...draft, [question.question]: toggleOption(question, item, label) });
  }

  protected type(question: AskedQuestion, event: Event): void {
    const draft = this.current();
    const item = draft[question.question] ?? { selected: [], text: '' };
    const text = (event.target as HTMLInputElement).value;
    this.draft.set({ ...draft, [question.question]: setText(question, item, text) });
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (this.busy() || this.reason() !== null) return;
    this.answered.emit(buildAnswerBody(this.questions(), this.current()));
  }
}
