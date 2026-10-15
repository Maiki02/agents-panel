import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import type { Project } from '@agents-panel/shared';
import { apiErrorMessage } from '../chats/chats.service';
import {
  PRIMARY_GIT_ACCOUNT_LABEL,
  accountProblem,
  accountsFor,
  defaultAccountId,
  gitAccountLabel,
  gitlabHosts,
} from '../accounts/git-accounts-logic';
import { GitAccountsService } from '../accounts/git-accounts.service';
import { Button } from '../ui/button';
import { Modal } from '../ui/modal';
import { ProjectsService } from './projects.service';
import { parseRepoInput } from './repo-input';

/**
 * "Nuevo proyecto" modal: the full GitHub or GitLab URL gives provider, repo and base branch (R29).
 * A GitLab project must pick a linked account of its host; a GitHub one may use the VM's login.
 */
@Component({
  selector: 'app-add-project-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal, Button],
  template: `
    <app-modal heading="Nuevo proyecto" (closed)="closed.emit()">
      <form (submit)="submit($event)">
        <label for="repo">URL del repositorio (GitHub o GitLab)</label>
        <input
          id="repo"
          name="repo"
          autocomplete="off"
          placeholder="https://github.com/usuario/repo o https://gitlab.com/grupo/subgrupo/repo"
          data-autofocus
          [class.invalid]="repoProblem() !== null"
          [value]="repo()"
          (input)="repo.set(text($event))"
        />
        @if (repoProblem(); as message) {
          <span class="error" role="alert">{{ message }}</span>
        } @else if (detected(); as found) {
          <span class="hint">
            {{ found.provider === 'gitlab' ? 'GitLab' : 'GitHub' }} · Repo: {{ found.slug }} · Rama:
            {{ found.branch ?? 'la predeterminada del repo' }}
          </span>
        }

        @if (detected(); as found) {
          <label for="git-account">
            Cuenta de {{ found.provider === 'gitlab' ? 'GitLab' : 'GitHub' }} ({{ found.host }})
          </label>
          <select
            id="git-account"
            name="git-account"
            [class.invalid]="accountError() !== null"
            [value]="accountValue()"
            (change)="chooseAccount($event)"
          >
            @if (found.provider === 'github') {
              <option value="">{{ primary }}</option>
            } @else {
              <option value="">Elegí una cuenta…</option>
            }
            @for (account of available(); track account.id) {
              <option [value]="account.id" [selected]="account.id === selectedId()">
                {{ label(account) }}
              </option>
            }
          </select>
          @if (accountError(); as message) {
            <span class="error" role="alert">{{ message }}</span>
          }
        }

        <label for="displayName">Nombre visible (opcional)</label>
        <input
          id="displayName"
          name="displayName"
          autocomplete="off"
          [value]="displayName()"
          (input)="displayName.set(text($event))"
        />

        @if (error(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }
        <button appButton type="submit" [disabled]="!canSubmit()">
          {{ busy() ? 'Agregando…' : 'Agregar' }}
        </button>
      </form>
    </app-modal>
  `,
})
export class AddProjectForm {
  private readonly service = inject(ProjectsService);
  private readonly gitAccounts = inject(GitAccountsService);

  readonly added = output<Project>();
  readonly closed = output();

  protected readonly primary = PRIMARY_GIT_ACCOUNT_LABEL;
  protected readonly label = gitAccountLabel;
  protected readonly repo = signal('');
  protected readonly displayName = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** What the user picked; null while untouched (a lone matching account is then used). */
  private readonly chosen = signal<number | null | undefined>(undefined);

  private readonly parsed = computed(() =>
    parseRepoInput(this.repo(), gitlabHosts(this.gitAccounts.accounts())),
  );
  protected readonly repoProblem = computed(() => {
    const parsed = this.parsed();
    return this.repo().trim() === '' || parsed.ok ? null : parsed.reason;
  });
  protected readonly detected = computed(() => {
    const parsed = this.parsed();
    return parsed.ok ? parsed : null;
  });
  protected readonly available = computed(() => {
    const found = this.detected();
    return found === null
      ? []
      : accountsFor(this.gitAccounts.accounts(), found.provider, found.host);
  });
  protected readonly selectedId = computed(() => {
    const picked = this.chosen();
    const available = this.available();
    if (picked !== undefined) return available.some((a) => a.id === picked) ? picked : null;
    // A GitLab project has no global login: a single account of its host is the obvious one.
    return this.detected()?.provider === 'gitlab' ? defaultAccountId(available) : null;
  });
  protected readonly accountValue = computed(() => String(this.selectedId() ?? ''));
  protected readonly accountError = computed(() => {
    const found = this.detected();
    if (found === null) return null;
    // Before the first pick the form only reports a missing account, not a nag on every keystroke.
    return accountProblem(found.provider, this.available(), this.selectedId(), found.host);
  });
  protected readonly canSubmit = computed(
    () => !this.busy() && this.parsed().ok && this.accountError() === null,
  );

  constructor() {
    // The accounts decide which hosts the URL may use; without them GitHub still works.
    void this.gitAccounts.refresh().catch(() => undefined);
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected chooseAccount(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.chosen.set(value === '' ? null : Number(value));
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canSubmit()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const display = this.displayName().trim();
      const accountId = this.selectedId();
      const project = await this.service.add({
        repo: this.repo().trim(),
        ...(display === '' ? {} : { displayName: display }),
        ...(accountId === null ? {} : { gitAccountId: accountId }),
      });
      this.added.emit(project);
      this.closed.emit();
    } catch (cause) {
      // Stay open with what was typed (a 409 "ya existe" included) so it can be fixed.
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.busy.set(false);
    }
  }
}
