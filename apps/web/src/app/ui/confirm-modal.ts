import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { Button } from './button';
import { Modal } from './modal';

/**
 * Confirmation of a destructive action: the parent renders it with `@if`, puts what will be lost
 * inside (every file, branch or commit named) and handles `(confirmed)` and `(closed)`. The error of
 * a refused attempt shows in the dialog; `busy` keeps the button from firing twice.
 */
@Component({
  selector: 'app-confirm-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Button, Modal],
  template: `
    <app-modal [heading]="heading()" (closed)="closed.emit()">
      <div class="flex flex-col gap-3 text-sm">
        <ng-content />
        @if (error(); as message) {
          <p class="error m-0" role="alert">{{ message }}</p>
        }
        <div class="flex justify-end gap-2">
          <button appButton variant="secondary" type="button" (click)="closed.emit()">
            Cancelar
          </button>
          <button
            appButton
            variant="danger"
            type="button"
            data-autofocus
            [disabled]="busy() || confirmDisabled()"
            (click)="confirmed.emit()"
          >
            {{ busy() ? 'Trabajando…' : confirmLabel() }}
          </button>
        </div>
      </div>
    </app-modal>
  `,
})
export class ConfirmModal {
  readonly heading = input.required<string>();
  readonly confirmLabel = input('Confirmar');
  readonly busy = input(false);
  readonly confirmDisabled = input(false);
  readonly error = input<string | null>(null);

  readonly confirmed = output();
  readonly closed = output();
}
