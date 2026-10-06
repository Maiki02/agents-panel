import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { apiErrorMessage } from '../chats/chats.service';
import { accountLabel } from './accounts-logic';
import { AccountsService } from './accounts.service';

/** Header dropdown: shows the active Claude account and switches to another one with one click. */
@Component({
  selector: 'app-account-selector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <label class="flex items-center gap-2 text-sm text-muted">
      <a routerLink="/accounts" class="text-muted hover:text-text hover:no-underline">Cuenta</a>
      <select
        aria-label="Cuenta de Claude"
        class="max-w-56 rounded-control border border-border bg-surface px-2 py-1 text-sm text-text"
        [disabled]="busy() || service.accounts().length === 0"
        (change)="choose($event)"
      >
        @for (account of service.accounts(); track account.id) {
          <option
            [value]="account.id"
            [selected]="account.active"
            [disabled]="!account.loggedIn"
            [title]="label(account)"
          >
            {{ account.name }}{{ account.loggedIn ? '' : ' (sin login)' }}
          </option>
        }
      </select>
    </label>
    @if (error(); as message) {
      <span class="error text-xs" role="alert">{{ message }}</span>
    }
  `,
  host: { class: 'flex items-center gap-2' },
})
export class AccountSelector {
  protected readonly service = inject(AccountsService);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly label = accountLabel;

  constructor() {
    // A successful reload (here or from the Cuentas page) clears an old error.
    effect(() => {
      this.service.accounts();
      this.error.set(null);
    });
    this.service.refresh().catch((cause: unknown) => {
      this.error.set(apiErrorMessage(cause));
    });
  }

  protected async choose(event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement;
    const id = Number(select.value);
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.service.activate(id);
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
      // Back to the account that is really active.
      select.value = String(this.service.active()?.id ?? '');
    } finally {
      this.busy.set(false);
    }
  }
}
