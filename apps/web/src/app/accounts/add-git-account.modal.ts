import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { GitAccount, GitProvider } from '@agents-panel/shared';
import { apiErrorMessage, isInvalidTotp } from '../chats/chats.service';
import { TotpModal } from '../shared/totp-modal';
import { Button } from '../ui/button';
import { Modal } from '../ui/modal';
import { canLinkAccount, defaultHost, newAccountBody, type LinkInput } from './git-accounts-logic';
import { GitAccountsService } from './git-accounts.service';

/**
 * "Vincular cuenta" (or "Reemplazar token" when `account` is set): the provider, name, host and token
 * are typed first, then the TOTP code is asked in the shared modal. The token lives only in this
 * component's signal and is cleared as soon as the request goes out or the modal closes.
 */
@Component({
  selector: 'app-add-git-account-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal, Button, TotpModal],
  template: `
    @if (!asking()) {
      <app-modal [heading]="heading()" (closed)="close()">
        <form (submit)="next($event)">
          @if (account() === null) {
            <label for="git-provider">Proveedor</label>
            <select
              id="git-provider"
              name="git-provider"
              [value]="provider()"
              (change)="setProvider($event)"
            >
              <option value="github">GitHub</option>
              <option value="gitlab">GitLab</option>
            </select>
            <label for="git-name">Nombre</label>
            <input
              id="git-name"
              name="git-name"
              autocomplete="off"
              placeholder="Miqueas - Trabajo"
              data-autofocus
              [value]="name()"
              (input)="name.set(text($event))"
            />
            @if (provider() === 'gitlab') {
              <label for="git-host">Host de GitLab</label>
              <input
                id="git-host"
                name="git-host"
                autocomplete="off"
                [value]="host()"
                (input)="host.set(text($event))"
              />
              <p class="hint">gitlab.com o el host de tu GitLab propio (solo https, sin puerto).</p>
            }
          } @else {
            <p class="hint">
              Cuenta {{ account()?.name }} ({{ account()?.username }}@{{ account()?.host }}). El
              token nuevo se valida contra el proveedor antes de guardarse.
            </p>
          }
          <label for="git-token">Token de acceso personal</label>
          <input
            id="git-token"
            name="git-token"
            type="password"
            autocomplete="off"
            spellcheck="false"
            [attr.data-autofocus]="account() === null ? null : ''"
            [value]="token()"
            (input)="token.set(text($event))"
          />
          <p class="hint">
            {{
              provider() === 'gitlab'
                ? 'GitLab: scope api (o read_repository y write_repository para clonar y pushear, más api para abrir MR).'
                : 'GitHub: un token con acceso al repo (scope repo).'
            }}
            El panel lo guarda cifrado y nunca lo muestra.
          </p>
          @if (error(); as message) {
            <p class="error" role="alert">{{ message }}</p>
          }
          <button appButton type="submit" [disabled]="!canSubmit()">Continuar</button>
        </form>
      </app-modal>
    } @else {
      <app-totp-modal
        [heading]="heading()"
        submitLabel="Confirmar"
        [busy]="busy()"
        [error]="totpError()"
        (submitted)="send($event)"
        (closed)="backToForm()"
      />
    }
  `,
})
export class AddGitAccountModal {
  private readonly service = inject(GitAccountsService);

  /** Set to replace the token of that account instead of linking a new one. */
  readonly account = input<GitAccount | null>(null);
  readonly closed = output();

  protected readonly provider = signal<GitProvider>('github');
  protected readonly name = signal('');
  protected readonly host = signal(defaultHost('gitlab'));
  protected readonly token = signal('');
  protected readonly busy = signal(false);
  protected readonly asking = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly totpError = signal<string | null>(null);

  protected readonly heading = computed(() =>
    this.account() === null
      ? 'Vincular cuenta de GitHub o GitLab'
      : `Reemplazar el token de ${this.account()?.name ?? ''}`,
  );
  private readonly link = computed<LinkInput>(() => {
    const existing = this.account();
    return {
      busy: this.busy(),
      provider: existing?.provider ?? this.provider(),
      // Replacing a token needs no name or host: the account already has them.
      name: existing?.name ?? this.name(),
      host: existing?.host ?? this.host(),
      token: this.token(),
    };
  });
  protected readonly canSubmit = computed(() => canLinkAccount(this.link()));

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected setProvider(event: Event): void {
    const provider = (event.target as HTMLSelectElement).value === 'gitlab' ? 'gitlab' : 'github';
    this.provider.set(provider);
    this.host.set(defaultHost(provider));
  }

  protected next(event: Event): void {
    event.preventDefault();
    if (!this.canSubmit()) return;
    this.error.set(null);
    this.totpError.set(null);
    this.asking.set(true);
  }

  protected backToForm(): void {
    this.asking.set(false);
    this.totpError.set(null);
  }

  protected close(): void {
    this.token.set('');
    this.closed.emit();
  }

  protected async send(code: string): Promise<void> {
    this.busy.set(true);
    this.totpError.set(null);
    const existing = this.account();
    try {
      if (existing === null) {
        await this.service.create(newAccountBody(this.link(), code));
      } else {
        await this.service.replaceToken(existing.id, this.token().trim(), code);
      }
      this.close();
    } catch (cause) {
      if (isInvalidTotp(cause)) {
        this.totpError.set(apiErrorMessage(cause));
      } else {
        // Back to the form with what was typed (the provider's refusal included) to fix it.
        this.error.set(apiErrorMessage(cause));
        this.asking.set(false);
      }
    } finally {
      this.busy.set(false);
    }
  }
}
