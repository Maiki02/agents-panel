import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { GitAccount, Project } from '@agents-panel/shared';
import { apiErrorMessage } from '../chats/chats.service';
import { ProjectsService } from '../projects/projects.service';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Icon } from '../ui/icon';
import { AddGitAccountModal } from './add-git-account.modal';
import {
  GIT_PROVIDER_LABEL,
  PRIMARY_GIT_ACCOUNT_LABEL,
  projectsUsing,
  unlinkWarning,
} from './git-accounts-logic';
import { GitAccountsService } from './git-accounts.service';

/** Cuentas de GitHub y GitLab: what the panel clones, pushes and opens PRs/MRs as. */
@Component({
  selector: 'app-git-accounts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, Badge, Button, Icon, AddGitAccountModal],
  template: `
    <div class="mt-8 mb-4 flex items-center justify-between gap-3">
      <h2 class="m-0">Cuentas de GitHub y GitLab</h2>
      <button appButton type="button" (click)="linking.set(true)">
        <app-icon name="plus" />
        Vincular cuenta
      </button>
    </div>
    <p class="hint">
      Cada proyecto actúa con una cuenta: la usa para clonar, pushear y abrir la PR o el MR. Los
      proyectos de GitHub sin cuenta usan el login de la VM; los de GitLab siempre necesitan una. El
      token se valida al vincular, se guarda cifrado y nunca se vuelve a mostrar.
    </p>
    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }

    <section class="card">
      <h3 class="m-0 flex flex-wrap items-center gap-2">
        {{ primary }}
        <app-badge tone="neutral">GitHub</app-badge>
      </h3>
      <p class="meta m-0">
        github.com · es el login global de <code>gh</code> en la VM; no se edita desde acá.
      </p>
    </section>

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
                <app-badge [tone]="account.provider === 'gitlab' ? 'accent' : 'neutral'">{{
                  label(account)
                }}</app-badge>
              </h3>
            }
            <p class="meta m-0">
              {{ account.host }} · usuario <code>{{ account.username }}</code> · alta
              {{ account.createdAt | date: 'shortDate' }}
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              appButton
              variant="secondary"
              type="button"
              [disabled]="busy()"
              (click)="startRename(account)"
            >
              Renombrar
            </button>
            <button
              appButton
              variant="secondary"
              type="button"
              [disabled]="busy()"
              (click)="replacing.set(account)"
            >
              Reemplazar token
            </button>
            <button
              appButton
              variant="danger"
              type="button"
              [disabled]="busy()"
              (click)="unlink(account)"
            >
              Desvincular
            </button>
          </div>
        </div>
      </section>
    }
    @if (linking()) {
      <app-add-git-account-modal (closed)="linking.set(false)" />
    }
    @if (replacing(); as account) {
      <app-add-git-account-modal [account]="account" (closed)="replacing.set(null)" />
    }
  `,
})
export class GitAccountsSection {
  protected readonly service = inject(GitAccountsService);
  private readonly projects = inject(ProjectsService);

  protected readonly primary = PRIMARY_GIT_ACCOUNT_LABEL;
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly editing = signal<number | null>(null);
  protected readonly draftName = signal('');
  protected readonly linking = signal(false);
  protected readonly replacing = signal<GitAccount | null>(null);

  constructor() {
    void this.run(() => this.service.refresh());
  }

  protected label(account: GitAccount): string {
    return GIT_PROVIDER_LABEL[account.provider];
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected startRename(account: GitAccount): void {
    this.draftName.set(account.name);
    this.editing.set(account.id);
  }

  protected async saveName(event: Event, account: GitAccount): Promise<void> {
    event.preventDefault();
    const ok = await this.run(() => this.service.rename(account.id, this.draftName().trim()));
    if (ok) this.editing.set(null);
  }

  protected async unlink(account: GitAccount): Promise<void> {
    let list: Project[] = [];
    try {
      list = await this.projects.list();
    } catch {
      // The warning only loses the names of the projects; the API still refuses what is unsafe.
    }
    if (!confirm(unlinkWarning(account, projectsUsing(account, list)))) return;
    await this.run(() => this.service.remove(account.id));
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
