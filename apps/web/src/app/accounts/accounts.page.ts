import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { ClaudeAccount } from '@agents-panel/shared';
import { apiErrorMessage } from '../chats/chats.service';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Icon } from '../ui/icon';
import { accountWarnings, canActivate } from './accounts-logic';
import { AddAccountModal } from './add-account.modal';
import { AccountsService } from './accounts.service';

/** Cuentas: the Claude logins of the VM the panel can run sessions with. */
@Component({
  selector: 'app-accounts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, Badge, Button, Icon, AddAccountModal],
  template: `
    <div class="mb-4 flex items-center justify-between gap-3">
      <h2 class="m-0">Cuentas de Claude</h2>
      <button appButton type="button" (click)="adding.set(true)">
        <app-icon name="plus" />
        Nueva cuenta
      </button>
    </div>
    <p class="hint">
      La cuenta activa es la de todo el panel: el próximo turno de cualquier chat corre con ella. Un
      turno que ya está corriendo termina con la suya.
    </p>
    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }

    @for (account of service.accounts(); track account.id) {
      <section class="card">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            @if (editing() === account.id) {
              <form class="flex flex-wrap items-center gap-2" (submit)="saveName($event, account)">
                <input
                  aria-label="Nombre de la cuenta"
                  name="name"
                  autocomplete="off"
                  data-autofocus
                  [value]="draftName()"
                  (input)="draftName.set(text($event))"
                />
                <button appButton type="submit" [disabled]="busy() || draftName().trim() === ''">
                  Guardar
                </button>
                <button appButton variant="secondary" type="button" (click)="editing.set(null)">
                  Cancelar
                </button>
              </form>
            } @else {
              <h3 class="m-0 flex flex-wrap items-center gap-2">
                {{ account.name }}
                @if (account.active) {
                  <app-badge tone="ok">Activa</app-badge>
                }
                @if (!account.loggedIn) {
                  <app-badge tone="danger">Sin login</app-badge>
                }
                @if (!account.linked) {
                  <app-badge tone="warn">Sin enlazar</app-badge>
                }
              </h3>
            }
            <p class="meta m-0">
              {{ account.email ?? 'email desconocido' }}
              @if (account.organization) {
                · {{ account.organization }}
              }
              · <code>{{ account.configDir ?? '~/.claude (principal)' }}</code> · alta
              {{ account.createdAt | date: 'shortDate' }}
            </p>
            @for (warning of warnings(account); track warning) {
              <p class="hint m-0" role="status">{{ warning }}</p>
            }
          </div>
          <div class="flex flex-wrap gap-2">
            @if (!account.active) {
              <button
                appButton
                type="button"
                [disabled]="busy() || !activable(account)"
                [title]="account.loggedIn ? '' : 'Sin login en la VM: no se puede usar'"
                (click)="activate(account)"
              >
                Usar esta
              </button>
            }
            <button
              appButton
              variant="secondary"
              type="button"
              [disabled]="busy()"
              (click)="startRename(account)"
            >
              Renombrar
            </button>
            @if (account.configDir !== null && !account.active) {
              <button
                appButton
                variant="danger"
                type="button"
                [disabled]="busy()"
                (click)="remove(account)"
              >
                Borrar
              </button>
            }
          </div>
        </div>
      </section>
    } @empty {
      <p class="hint">Todavía no hay cuentas. Agregá la primera con «Nueva cuenta».</p>
    }
    @if (adding()) {
      <app-add-account-modal (closed)="onModalClosed()" />
    }
  `,
})
export class AccountsPage {
  protected readonly service = inject(AccountsService);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly editing = signal<number | null>(null);
  protected readonly draftName = signal('');
  protected readonly adding = signal(false);
  protected readonly warnings = accountWarnings;
  protected readonly activable = canActivate;

  constructor() {
    void this.run(() => this.service.refresh());
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async activate(account: ClaudeAccount): Promise<void> {
    await this.run(() => this.service.activate(account.id));
  }

  protected startRename(account: ClaudeAccount): void {
    this.draftName.set(account.name);
    this.editing.set(account.id);
  }

  protected async saveName(event: Event, account: ClaudeAccount): Promise<void> {
    event.preventDefault();
    const ok = await this.run(() => this.service.rename(account.id, this.draftName().trim()));
    if (ok) this.editing.set(null);
  }

  protected async remove(account: ClaudeAccount): Promise<void> {
    if (!confirm(`¿Borrar la cuenta "${account.name}" del panel? El login en la VM no se toca.`)) {
      return;
    }
    await this.run(() => this.service.remove(account.id));
  }

  protected onModalClosed(): void {
    this.adding.set(false);
  }

  /** Runs an action with the busy flag and shows the API's error; true when it worked. */
  private async run(action: () => Promise<void>): Promise<boolean> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await action();
      return true;
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
