import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';

/**
 * Asks for a fresh TOTP code (R18). The code lives only in this field: it is emitted once and
 * cleared right away, so it is never kept after sending, whether the action succeeds or fails.
 */
@Component({
  selector: 'app-totp-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="totp" (submit)="submit($event)">
      <label>
        {{ label() }}
        <input
          name="totp"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          pattern="[0-9]{6}"
          maxlength="6"
          [value]="code()"
          (input)="code.set($any($event.target).value)"
          [disabled]="busy()"
        />
      </label>
      <button type="submit" [disabled]="busy() || code().length !== 6">{{ submitLabel() }}</button>
      <button type="button" class="secondary" (click)="cancel()" [disabled]="busy()">
        Cancelar
      </button>
    </form>
  `,
})
export class TotpDialog {
  readonly label = input('Código de la app (6 dígitos)');
  readonly submitLabel = input('Confirmar');
  readonly busy = input(false);
  readonly submitted = output<string>();
  readonly cancelled = output();

  protected readonly code = signal('');

  protected submit(event: Event): void {
    event.preventDefault();
    const value = this.code().trim();
    if (value.length !== 6) return;
    this.code.set('');
    this.submitted.emit(value);
  }

  protected cancel(): void {
    this.code.set('');
    this.cancelled.emit();
  }
}
