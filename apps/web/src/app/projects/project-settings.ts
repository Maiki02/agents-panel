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
import type { Project } from '@agents-panel/shared';
import { apiErrorMessage } from '../chats/chats.service';
import {
  PRIMARY_GIT_ACCOUNT_LABEL,
  accountProblem,
  accountsFor,
  gitAccountLabel,
  projectHost,
} from '../accounts/git-accounts-logic';
import { GitAccountsService } from '../accounts/git-accounts.service';
import { providerTexts } from './project-label';
import { failedField, validateCommandValue } from './settings-logic';
import { ProjectsService } from './projects.service';
import { Button } from '../ui/button';

@Component({
  selector: 'app-project-general',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Button],
  template: `
    <form (submit)="save($event)">
      <label for="cfg-display">Nombre visible</label>
      <input
        id="cfg-display"
        autocomplete="off"
        [value]="displayName()"
        (input)="displayName.set(text($event))"
      />
      <label for="cfg-account">Cuenta de {{ texts().name }} ({{ host() }})</label>
      <select
        id="cfg-account"
        [class.invalid]="accountProblem() !== null"
        [value]="accountValue()"
        (change)="chooseAccount($event)"
      >
        @if (project().gitProvider === 'gitlab') {
          <option value="">Elegí una cuenta…</option>
        } @else {
          <option value="">{{ primary }}</option>
        }
        @for (account of available(); track account.id) {
          <option [value]="account.id" [selected]="account.id === accountId()">
            {{ label(account) }}
          </option>
        }
      </select>
      <p class="hint">
        Con esta cuenta el panel clona, pushea y abre {{ texts().thePr }} de este proyecto.
        @if (project().gitProvider !== 'gitlab') {
          Sin cuenta usa el login de gh de la VM.
        }
      </p>
      @if (accountProblem(); as problem) {
        <span class="error" role="alert">{{ problem }}</span>
      }
      <label for="cfg-branch">Rama base</label>
      <input
        id="cfg-branch"
        autocomplete="off"
        [value]="baseBranch()"
        (input)="baseBranch.set(text($event))"
      />
      <label for="cfg-setup">Comando de setup (vacío = sin setup)</label>
      <input
        id="cfg-setup"
        autocomplete="off"
        [value]="setupCommand()"
        (input)="setupCommand.set(text($event))"
      />
      <label for="cfg-validate">Comando de validación (vacío = sin validación)</label>
      <input
        id="cfg-validate"
        autocomplete="off"
        placeholder="npm run build"
        [class.invalid]="validateProblem() !== null || fieldError() === 'validate'"
        [value]="validateCommand()"
        (input)="validateCommand.set(text($event))"
      />
      <p class="hint">
        Lo corre el piloto en el worktree, sin shell y con un tiempo máximo, antes de abrir
        {{ texts().thePr }}. Si falla, frena y no abre {{ texts().thePr }}. Sin comando, el merge no
        valida y el Timeline lo anota.
      </p>
      @if (validateProblem(); as problem) {
        <span class="error" role="alert">{{ problem }}</span>
      } @else if (fieldError() === 'validate' && error(); as message) {
        <span class="error" role="alert">{{ message }}</span>
      }
      <button
        appButton
        type="submit"
        [disabled]="
          busy() ||
          baseBranch().trim() === '' ||
          validateProblem() !== null ||
          accountProblem() !== null
        "
      >
        {{ busy() ? 'Guardando…' : 'Guardar' }}
      </button>
      @if (saved()) {
        <p class="hint" role="status">Guardado.</p>
      }
      @if (fieldError() === 'form' && error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
    </form>
  `,
})
export class ProjectGeneralSettings {
  private readonly service = inject(ProjectsService);

  readonly project = input.required<Project>();
  readonly changed = output<Project>();

  private readonly gitAccounts = inject(GitAccountsService);

  protected readonly primary = PRIMARY_GIT_ACCOUNT_LABEL;
  protected readonly label = gitAccountLabel;
  protected readonly texts = computed(() => providerTexts(this.project()));
  protected readonly host = computed(() => projectHost(this.project()));
  protected readonly available = computed(() =>
    accountsFor(this.gitAccounts.accounts(), this.project().gitProvider, this.host()),
  );
  protected readonly accountId = signal<number | null>(null);
  protected readonly accountValue = computed(() => String(this.accountId() ?? ''));
  protected readonly accountProblem = computed(() =>
    accountProblem(this.project().gitProvider, this.available(), this.accountId(), this.host()),
  );
  protected readonly displayName = signal('');
  protected readonly baseBranch = signal('');
  protected readonly setupCommand = signal('');
  protected readonly validateCommand = signal('');
  protected readonly validateProblem = computed(
    () => validateCommandValue(this.validateCommand()).problem,
  );
  /** Field a failed save is shown next to; the form itself when it cannot be told. */
  protected readonly fieldError = signal<'validate' | 'setup' | 'form'>('form');
  protected readonly busy = signal(false);
  protected readonly saved = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      const p = this.project();
      this.displayName.set(p.displayName ?? '');
      this.baseBranch.set(p.baseBranch);
      this.setupCommand.set(p.setupCommand ?? '');
      this.validateCommand.set(p.validateCommand ?? '');
      this.accountId.set(p.gitAccountId);
    });
    void this.gitAccounts.refresh().catch(() => undefined);
  }

  protected chooseAccount(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.accountId.set(value === '' ? null : Number(value));
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    this.busy.set(true);
    this.saved.set(false);
    this.error.set(null);
    try {
      const display = this.displayName().trim();
      const setup = this.setupCommand().trim();
      const validate = validateCommandValue(this.validateCommand()).value;
      const command = setup === '' ? null : setup;
      const project = this.project();
      this.fieldError.set(
        failedField(
          { setupCommand: project.setupCommand, validateCommand: project.validateCommand },
          { setupCommand: command, validateCommand: validate },
        ),
      );
      const updated = await this.service.patch(project.id, {
        displayName: display === '' ? null : display,
        baseBranch: this.baseBranch().trim(),
        setupCommand: command,
        validateCommand: validate,
        // Only sent when it changed: saving a name must not re-check the account.
        ...(this.accountId() === project.gitAccountId ? {} : { gitAccountId: this.accountId() }),
      });
      this.changed.emit(updated);
      this.saved.set(true);
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.busy.set(false);
    }
  }
}
