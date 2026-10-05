import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { debtActionState, type DebtView } from './approval-logic';
import { ChatsService, apiErrorMessage } from './chats.service';

/**
 * The scope is done but debt is still open: the pilot stopped and waits. Completing anyway is the
 * user's explicit OK, with the reason that stays in the Timeline.
 */
@Component({
  selector: 'app-debt-approval-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Badge, Button],
  template: `
    <section class="card approval" aria-label="Deuda abierta">
      <h2>El scope tiene deuda abierta</h2>
      <p class="hint">
        El piloto no lo completa solo. Podés completarlo aceptando la deuda: queda registrado con tu
        motivo.
      </p>
      <ul class="debt-list">
        @for (item of debt(); track item.id) {
          <li>
            <app-badge
              [tone]="item.priority === 'critical' || item.priority === 'high' ? 'warn' : 'neutral'"
            >
              {{ item.priority }}
            </app-badge>
            <strong>{{ item.id }}</strong> {{ item.title }}
          </li>
        } @empty {
          <li class="hint">No se pudo leer la lista de deuda.</li>
        }
      </ul>

      <label for="debt-reason">Motivo (obligatorio)</label>
      <textarea
        id="debt-reason"
        rows="2"
        maxlength="2000"
        [disabled]="busy()"
        [value]="reason()"
        (input)="reason.set(text($event))"
      ></textarea>
      <div class="approval-actions">
        <button
          appButton
          type="button"
          [disabled]="state().disabled"
          [title]="state().reason ?? ''"
          (click)="accept()"
        >
          Completar aceptando la deuda
        </button>
      </div>
      @if (state().reason; as why) {
        <p class="hint" role="status">{{ why }}</p>
      }
      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
    </section>
  `,
})
export class DebtApprovalCard {
  private readonly service = inject(ChatsService);

  readonly chatId = input.required<number>();
  readonly debt = input.required<DebtView[]>();
  /** The scope was completed: the page reads the new state of the chat. */
  readonly accepted = output();

  protected readonly reason = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly state = computed(() =>
    debtActionState({ reason: this.reason(), busy: this.busy() }),
  );

  protected text(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }

  protected async accept(): Promise<void> {
    if (this.state().disabled) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.service.acceptDebt(this.chatId(), this.reason().trim());
      this.reason.set('');
      this.accepted.emit();
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.busy.set(false);
    }
  }
}
