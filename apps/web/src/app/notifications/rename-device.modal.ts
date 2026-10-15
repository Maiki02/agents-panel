import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { PushSubscriptionInfo } from '@agents-panel/shared';
import { apiErrorMessage } from '../chats/chats.service';
import { Button } from '../ui/button';
import { Modal } from '../ui/modal';
import { NotificationsService } from './notifications.service';
import { canRenameDevice } from './notifications-logic';

/** "Renombrar" modal: edits the name of one device and saves it with the trimmed value. */
@Component({
  selector: 'app-rename-device-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal, Button],
  template: `
    <app-modal heading="Renombrar dispositivo" (closed)="closed.emit()">
      <form (submit)="submit($event)">
        <label for="rename-device-name">Nombre</label>
        <input
          id="rename-device-name"
          name="rename-device-name"
          autocomplete="off"
          maxlength="80"
          data-autofocus
          [value]="name()"
          (input)="name.set(text($event))"
        />
        @if (error(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }
        <div class="flex flex-wrap gap-2">
          <button appButton type="submit" [disabled]="!canSubmit()">
            {{ busy() ? 'Guardando…' : 'Confirmar' }}
          </button>
          <button appButton variant="secondary" type="button" (click)="closed.emit()">
            Cancelar
          </button>
        </div>
      </form>
    </app-modal>
  `,
})
export class RenameDeviceModal {
  private readonly service = inject(NotificationsService);

  readonly device = input.required<PushSubscriptionInfo>();
  /** The name was saved: the page refreshes the list and closes the modal. */
  readonly renamed = output();
  readonly closed = output();

  protected readonly name = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly value = computed(() => this.name() ?? this.device().name);
  protected readonly canSubmit = computed(() =>
    canRenameDevice(this.busy(), this.value(), this.device().name),
  );

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canSubmit()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.service.rename(this.device().id, this.value().trim());
      this.renamed.emit();
    } catch (cause) {
      // Stay open so the reason is read where the button was pressed.
      this.error.set(
        cause instanceof Error && !('status' in cause) ? cause.message : apiErrorMessage(cause),
      );
    } finally {
      this.busy.set(false);
    }
  }
}
