import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { apiErrorMessage } from '../chats/chats.service';
import { Button } from '../ui/button';
import { Modal } from '../ui/modal';
import { NotificationsService } from './notifications.service';
import {
  addDeviceAvailability,
  canActivateDevice,
  subscriptionBody,
  suggestedName,
  type PushSupport,
} from './notifications-logic';
import { PushBrowser } from './push-browser';

/** "Agregar este dispositivo" modal: names this browser and subscribes it to Web Push. */
@Component({
  selector: 'app-add-device-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal, Button],
  template: `
    <app-modal heading="Agregar este dispositivo" (closed)="closed.emit()">
      <form (submit)="submit($event)">
        <label for="device-name">Nombre</label>
        <input
          id="device-name"
          name="device-name"
          autocomplete="off"
          maxlength="80"
          data-autofocus
          [value]="name()"
          (input)="name.set(text($event))"
        />
        @if (availability().reason; as why) {
          <p class="hint" role="status" data-testid="support-reason">{{ why }}</p>
        }
        @if (error(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }
        <button appButton type="submit" [disabled]="!canSubmit()">
          {{ busy() ? 'Activando…' : 'Activar' }}
        </button>
      </form>
    </app-modal>
  `,
})
export class AddDeviceModal {
  private readonly service = inject(NotificationsService);
  private readonly browser = inject(PushBrowser);

  readonly support = input.required<PushSupport | null>();
  readonly publicKey = input.required<string | null>();
  /** The endpoint of the new subscription, once the panel has it saved. */
  readonly added = output<string>();
  readonly closed = output();

  protected readonly name = signal(suggestedName(this.browser.userAgent()));
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly availability = computed(() => addDeviceAvailability(this.support()));
  protected readonly canSubmit = computed(() =>
    canActivateDevice(this.busy(), this.name(), this.support()),
  );

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    const publicKey = this.publicKey();
    if (!this.canSubmit() || publicKey === null) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const subscription = await this.browser.subscribe(publicKey);
      const body = subscriptionBody(subscription.toJSON(), this.name().trim());
      if (body === null) throw new Error('El navegador no devolvió las claves de la suscripción.');
      await this.service.subscribe(body);
      this.added.emit(subscription.endpoint);
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
