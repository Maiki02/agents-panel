import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { ClaudeAccount } from '@agents-panel/shared';
import { apiErrorMessage, isInvalidTotp } from '../chats/chats.service';
import { TotpModal } from '../shared/totp-modal';
import { Button } from '../ui/button';
import { Modal } from '../ui/modal';
import { canSendReloginCode, safeAuthLink } from './accounts-logic';
import { AccountsService } from './accounts.service';

/**
 * "Reloguear" a Claude account in three steps: the TOTP (it launches the login on the VM), the link
 * to authorize in the browser, and the code the browser shows. The code lives only in this
 * component's signal and is cleared when it is sent, on error and when the modal closes; closing
 * half way cancels the login on the VM.
 */
@Component({
  selector: 'app-relogin-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal, Button, TotpModal],
  template: `
    @if (step() === 'totp') {
      <app-totp-modal
        [heading]="heading()"
        submitLabel="Empezar"
        [busy]="busy()"
        [error]="totpError()"
        (submitted)="start($event)"
        (closed)="close()"
      />
    } @else {
      <app-modal [heading]="heading()" (closed)="close()">
        <form (submit)="finish($event)">
          <p class="hint m-0">
            1. Abrí el link, entrá con la cuenta de Claude y autorizá. 2. Copiá el código que te
            muestra el navegador y pegalo acá.
          </p>
          @if (href(); as link) {
            <p class="m-0">
              <a class="link break-all" [href]="link" target="_blank" rel="noopener noreferrer">
                Abrir el link de autorización
              </a>
            </p>
          }
          <label for="relogin-code">Código</label>
          <input
            id="relogin-code"
            name="relogin-code"
            type="password"
            autocomplete="off"
            spellcheck="false"
            data-autofocus
            [value]="code()"
            [disabled]="busy()"
            (input)="code.set(text($event))"
          />
          @if (error(); as message) {
            <p class="error" role="alert">{{ message }}</p>
          }
          <button appButton type="submit" [disabled]="!canSend()">
            {{ busy() ? 'Confirmando…' : 'Confirmar' }}
          </button>
        </form>
      </app-modal>
    }
  `,
})
export class ReloginModal {
  private readonly service = inject(AccountsService);

  readonly account = input.required<ClaudeAccount>();
  readonly closed = output();

  protected readonly step = signal<'totp' | 'code'>('totp');
  protected readonly busy = signal(false);
  protected readonly totpError = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly code = signal('');
  private readonly link = signal<string | null>(null);

  protected readonly heading = computed(() => `Reloguear ${this.account().name}`);
  protected readonly href = computed(() => {
    const url = this.link();
    return url === null ? null : safeAuthLink(url);
  });
  protected readonly canSend = computed(() => canSendReloginCode(this.busy(), this.code()));

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async start(totp: string): Promise<void> {
    this.busy.set(true);
    this.totpError.set(null);
    try {
      this.link.set(await this.service.startRelogin(this.account().id, totp));
      this.step.set('code');
    } catch (cause) {
      // A wrong code and any other refusal (flow already running, no link) both stay in the modal.
      this.totpError.set(
        isInvalidTotp(cause)
          ? apiErrorMessage(cause)
          : `No se pudo empezar: ${apiErrorMessage(cause)}`,
      );
    } finally {
      this.busy.set(false);
    }
  }

  protected async finish(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canSend()) return;
    const code = this.code().trim();
    this.code.set('');
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.service.finishRelogin(this.account().id, code);
      this.step.set('totp');
      this.link.set(null);
      this.closed.emit();
    } catch (cause) {
      // The API ends the flow on any failure: start again with a new link.
      this.error.set(`${apiErrorMessage(cause)} Cerrá esta ventana y volvé a empezar.`);
    } finally {
      this.busy.set(false);
    }
  }

  protected close(): void {
    this.code.set('');
    if (this.step() === 'code') void this.service.cancelRelogin(this.account().id);
    this.closed.emit();
  }
}
