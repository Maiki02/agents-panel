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
import type { AutopilotInfo, ChatKind, WorktreeStateId } from '@agents-panel/shared';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Modal } from '../ui/modal';
import { PILOT_LABEL, pilotControls, pilotStatus, type PilotControl } from './autopilot-logic';
import { ChatsService, apiErrorMessage } from './chats.service';

/**
 * Pilot controls of a scope or work: switch on, pause, resume and switch off. Every action that
 * does not apply is disabled with its reason; switching off asks first because it leaves the work
 * in manual mode. The server has the last word: its 409 message is shown as it is.
 */
@Component({
  selector: 'app-autopilot-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Badge, Button, Modal],
  template: `
    <section
      class="my-3 flex flex-col gap-2 rounded-card border border-border bg-surface px-3 py-2"
      aria-label="Piloto automático"
    >
      <div class="flex flex-wrap items-center gap-2">
        <app-badge [tone]="status().tone">{{ status().label }}</app-badge>
        @if (status().sessions; as sessions) {
          <span class="text-xs text-muted">{{ sessions }}</span>
        }
        <div class="ml-auto flex flex-wrap gap-2">
          @for (action of actions; track action) {
            <button
              appButton
              type="button"
              [variant]="action === 'off' ? 'danger' : 'primary'"
              [disabled]="controls()[action].disabled || busy()"
              [title]="controls()[action].reason ?? ''"
              (click)="press(action)"
            >
              {{ label[action] }}
            </button>
          }
        </div>
      </div>
      @if (status().stopReason; as reason) {
        <p class="m-0 text-sm text-warn">{{ reason }}</p>
      }
      <ul class="m-0 list-none p-0 text-xs text-muted">
        @for (action of actions; track action) {
          @if (controls()[action].reason; as why) {
            <li>{{ label[action] }}: {{ why }}</li>
          }
        }
      </ul>
      @if (error(); as message) {
        <p class="error m-0" role="alert">{{ message }}</p>
      }
    </section>
    @if (confirming()) {
      <app-modal heading="Apagar el piloto" (closed)="confirming.set(false)">
        <p class="hint">
          El trabajo queda en modo manual: nadie abre el paso siguiente hasta que lo vuelvas a
          encender. No se pierde nada de lo hecho.
        </p>
        <button appButton variant="danger" type="button" [disabled]="busy()" (click)="turnOff()">
          Apagar piloto
        </button>
      </app-modal>
    }
  `,
})
export class AutopilotBar {
  private readonly service = inject(ChatsService);

  readonly chatId = input.required<number>();
  readonly kind = input.required<ChatKind>();
  /** Fine state of the work: the bar reads the run again whenever it changes. */
  readonly workState = input<WorktreeStateId | null>(null);
  /** An action went through: the page reads the state again. */
  readonly changed = output();

  protected readonly actions: readonly PilotControl[] = ['on', 'resume', 'pause', 'off'];
  protected readonly label = PILOT_LABEL;
  protected readonly info = signal<AutopilotInfo | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly confirming = signal(false);

  protected readonly controls = computed(() =>
    pilotControls({
      kind: this.kind(),
      run: this.info()?.run ?? null,
      workState: this.workState(),
    }),
  );
  protected readonly status = computed(() =>
    pilotStatus(this.info()?.run ?? null, this.info()?.maxSessionsPerSprint ?? 0),
  );

  constructor() {
    effect(() => {
      this.workState();
      const id = this.chatId();
      void this.load(id);
    });
  }

  private async load(id: number): Promise<void> {
    if (this.kind() === 'direct' || this.kind() === 'idea') {
      this.info.set(null);
      return;
    }
    try {
      const info = await this.service.autopilot(id);
      if (id === this.chatId()) this.info.set(info);
    } catch (cause) {
      if (id === this.chatId()) this.error.set(apiErrorMessage(cause));
    }
  }

  protected press(action: PilotControl): void {
    if (this.controls()[action].disabled || this.busy()) return;
    if (action === 'off') this.confirming.set(true);
    else void this.send(action);
  }

  protected async turnOff(): Promise<void> {
    await this.send('off');
    this.confirming.set(false);
  }

  private async send(action: PilotControl): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const info = await this.service.autopilotAction(this.chatId(), action);
      this.info.set(info);
      this.changed.emit();
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
      await this.load(this.chatId());
    } finally {
      this.busy.set(false);
    }
  }
}
