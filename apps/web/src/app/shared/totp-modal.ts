import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { Button } from '../ui/button';
import { Modal } from '../ui/modal';
import { isCompleteCode, sanitizeCode, takeCode } from './totp-code';

/**
 * Asks for a fresh TOTP code (R18) in a modal. The code lives only in this field: it is emitted
 * once and cleared right away, and also cleared when the modal closes, so it is never kept.
 * The parent shows a failure through `error` and keeps the modal open (or closes it on success).
 */
@Component({
  selector: 'app-totp-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal, Button],
  template: `
    <app-modal [heading]="heading()" (closed)="close()">
      <form (submit)="submit($event)">
        <label for="totp-code">Código de la app (6 dígitos)</label>
        <input
          id="totp-code"
          name="totp"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="6"
          data-autofocus
          [value]="code()"
          (input)="code.set(clean($event))"
          [disabled]="busy()"
        />
        @if (error(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }
        <button appButton type="submit" [disabled]="busy() || !complete()">
          {{ submitLabel() }}
        </button>
      </form>
    </app-modal>
  `,
})
export class TotpModal {
  readonly heading = input('Confirmar con tu código');
  readonly submitLabel = input('Enviar');
  readonly busy = input(false);
  readonly error = input<string | null>(null);
  readonly submitted = output<string>();
  readonly closed = output();

  protected readonly code = signal('');
  protected readonly complete = computed(() => isCompleteCode(this.code()));

  protected clean(event: Event): string {
    return sanitizeCode((event.target as HTMLInputElement).value);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    const { send, remaining } = takeCode(this.code());
    this.code.set(remaining);
    if (send !== null) this.submitted.emit(send);
  }

  protected close(): void {
    this.code.set('');
    this.closed.emit();
  }
}
