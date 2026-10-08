import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { PushConfig, PushSubscriptionInfo } from '@agents-panel/shared';
import { apiErrorMessage } from '../chats/chats.service';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Icon } from '../ui/icon';
import { NotificationsService } from './notifications.service';
import { addDeviceAvailability, pushSupport, testMessage, type PushSupport } from './notifications-logic';
import { AddDeviceModal } from './add-device.modal';
import { PushBrowser } from './push-browser';

/**
 * Notificaciones: the devices of the logged-in user that receive Web Push. It is not a project
 * setting: the devices belong to the user, so it lives next to Versiones in the header.
 */
@Component({
  selector: 'app-notifications',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Badge, Button, Icon, AddDeviceModal],
  template: `
    <div class="mb-4 flex items-center justify-between gap-3">
      <h2 class="m-0">Notificaciones</h2>
      <button
        appButton
        type="button"
        [disabled]="!addDevice().available || busy()"
        [attr.title]="addDevice().reason"
        (click)="adding.set(true)"
      >
        <app-icon name="plus" />
        Agregar este dispositivo
      </button>
    </div>
    <p class="hint">
      El panel te avisa en este y en tus otros dispositivos cuando un trabajo frena, te hace una
      pregunta o deja la PR lista, aunque la pestaña esté cerrada.
    </p>
    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }
    @if (notice(); as message) {
      <p class="hint" role="status">{{ message }}</p>
    }

    @if (adding()) {
      <app-add-device-modal
        [support]="support()"
        [publicKey]="config()?.publicKey ?? null"
        (added)="onAdded($event)"
        (closed)="adding.set(false)"
      />
    }

    <section class="card">
      <h3>Dispositivos que reciben avisos</h3>
      <ul class="m-0 flex list-none flex-col gap-3 p-0">
        @for (item of devices(); track item.id) {
          <li class="flex flex-col gap-2 rounded-card border border-border px-3 py-2">
            <div class="flex flex-wrap items-center gap-2">
              <strong>{{ item.name }}</strong>
              @if (item.endpoint === here()) {
                <app-badge tone="accent">Este dispositivo</app-badge>
              }
              <span class="ml-auto text-xs text-muted">
                {{
                  item.lastSuccessAt === null
                    ? 'Sin avisos enviados'
                    : 'Último aviso ' + time(item.lastSuccessAt)
                }}
              </span>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <input
                class="min-w-0 flex-1"
                [attr.aria-label]="'Nombre de ' + item.name"
                maxlength="80"
                [value]="draft(item)"
                (input)="rename(item.id, text($event))"
              />
              <button
                appButton
                variant="secondary"
                type="button"
                [disabled]="busy() || draft(item).trim() === '' || draft(item).trim() === item.name"
                (click)="saveName(item)"
              >
                Renombrar
              </button>
              <button
                appButton
                variant="secondary"
                type="button"
                [disabled]="busy()"
                (click)="test(item)"
              >
                Probar
              </button>
              <button
                appButton
                variant="danger"
                type="button"
                [disabled]="busy()"
                (click)="remove(item)"
              >
                Quitar
              </button>
            </div>
          </li>
        } @empty {
          @if (loaded()) {
            <li class="text-sm text-muted">
              Ningún dispositivo recibe avisos todavía. Entrá desde el que quieras avisar y tocá
              «Agregar este dispositivo».
            </li>
          } @else {
            <li class="text-sm text-muted" role="status">Cargando…</li>
          }
        }
      </ul>
    </section>
  `,
})
export class NotificationsPage {
  private readonly service = inject(NotificationsService);
  private readonly browser = inject(PushBrowser);

  /** Start from the last answers the service knows, so coming back paints at once. */
  private readonly knownConfig = this.service.cachedConfig();
  private readonly knownDevices = this.service.cachedList();
  protected readonly config = signal<PushConfig | null>(this.knownConfig ?? null);
  protected readonly devices = signal<PushSubscriptionInfo[]>(this.knownDevices ?? []);
  /**
   * Endpoint of this browser's own subscription; null when it has none, undefined while the
   * browser has not answered yet. It never holds back the list of devices.
   */
  protected readonly here = signal<string | null | undefined>(undefined);
  protected readonly names = signal<Record<number, string>>({});
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly loaded = signal(
    this.knownConfig !== undefined && this.knownDevices !== undefined,
  );

  protected readonly support = computed<PushSupport | null>(() => {
    const config = this.config();
    const here = this.here();
    if (config === null || !this.loaded() || here === undefined) return null;
    return pushSupport({
      ...this.browser.environment(),
      serverEnabled: config.enabled,
      subscribed: here !== null && this.devices().some((d) => d.endpoint === here),
    });
  });

  protected readonly adding = signal(false);
  protected readonly addDevice = computed(() => addDeviceAvailability(this.support()));

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    // The browser's own subscription can take long: it is asked on its own, not awaited here.
    void this.browser
      .current()
      .catch(() => null)
      .then((current) => {
        this.here.set(current?.endpoint ?? null);
      });
    try {
      const [config, devices] = await Promise.all([this.service.config(), this.service.list()]);
      this.config.set(config);
      this.devices.set(devices);
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.loaded.set(true);
    }
  }

  private async refreshList(): Promise<void> {
    this.devices.set(await this.service.list());
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected draft(item: PushSubscriptionInfo): string {
    return this.names()[item.id] ?? item.name;
  }

  protected rename(id: number, value: string): void {
    this.names.update((names) => ({ ...names, [id]: value }));
  }

  protected time(epochMs: number): string {
    return new Date(epochMs).toLocaleString('es-AR', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      await action();
    } catch (cause) {
      this.error.set(
        cause instanceof Error && !('status' in cause) ? cause.message : apiErrorMessage(cause),
      );
    } finally {
      this.busy.set(false);
    }
  }

  /** The modal saved the subscription: refresh the list, close it and leave the notice. */
  protected async onAdded(endpoint: string): Promise<void> {
    this.here.set(endpoint);
    this.adding.set(false);
    await this.run(async () => {
      await this.refreshList();
      this.notice.set('Listo: este dispositivo recibe avisos. Probalo con el botón «Probar».');
    });
  }

  protected async saveName(item: PushSubscriptionInfo): Promise<void> {
    await this.run(async () => {
      await this.service.rename(item.id, this.draft(item).trim());
      await this.refreshList();
    });
  }

  protected async test(item: PushSubscriptionInfo): Promise<void> {
    await this.run(async () => {
      const result = await this.service.test(item.id);
      this.notice.set(testMessage(result));
      await this.refreshList();
    });
  }

  protected async remove(item: PushSubscriptionInfo): Promise<void> {
    await this.run(async () => {
      await this.service.remove(item.id);
      if (item.endpoint === this.here()) {
        await this.browser.unsubscribe().catch(() => undefined);
        this.here.set(null);
      }
      await this.refreshList();
    });
  }
}
