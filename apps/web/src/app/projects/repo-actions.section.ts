import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import type { KyroBranchResult, Project, PullResult } from '@agents-panel/shared';
import { apiErrorMessage, isInvalidTotp } from '../chats/chats.service';
import { TotpModal } from '../shared/totp-modal';
import { Button } from '../ui/button';
import { kyroBranchSummary, pullSummary } from './repo-actions';
import { ProjectsService } from './projects.service';

/** Configuración > Repositorio: bring GitHub into the base clone and add Kyro on its own branch. */
@Component({
  selector: 'app-repo-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Button, TotpModal],
  template: `
    <h3>Clon base</h3>
    <p class="hint">
      Los worktrees nuevos salen de la rama {{ project().baseBranch }} del clon de la VM. Traé lo
      último de GitHub antes de empezar un trabajo. Solo avanza (fast-forward): si hay cambios
      locales o el clon se desvió, no toca nada.
    </p>
    <button appButton type="button" [disabled]="pulling() || !ready()" (click)="pull()">
      {{ pulling() ? 'Trayendo…' : 'Traer cambios de GitHub' }}
    </button>
    @if (pullResult(); as result) {
      <p class="hint" role="status">{{ summary(result) }}</p>
    }
    @if (pullError(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }

    <h3 class="pt-4">Kyro</h3>
    @if (project().hasKyro) {
      <p class="hint">Este proyecto ya tiene Kyro.</p>
    } @else {
      <p class="hint">
        Este proyecto no tiene Kyro, así que solo admite pedidos directos. Inicializarlo crea la
        rama chore/kyro-init en su propio worktree, con un commit; el clon base no se toca.
      </p>
      <button
        appButton
        type="button"
        [disabled]="initBusy() || !ready()"
        (click)="initAsking.set(true)"
      >
        Inicializar Kyro
      </button>
    }
    @if (branch(); as result) {
      <p class="hint" role="status">{{ branchText(result) }}</p>
    }
    @if (initError(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }
    @if (initAsking()) {
      <app-totp-modal
        heading="Inicializar Kyro"
        submitLabel="Inicializar"
        [busy]="initBusy()"
        [error]="totpError()"
        (submitted)="initKyro($event)"
        (closed)="closeInit()"
      />
    }
  `,
})
export class RepoActionsSection {
  private readonly service = inject(ProjectsService);

  readonly project = input.required<Project>();

  protected readonly pulling = signal(false);
  protected readonly pullResult = signal<PullResult | null>(null);
  protected readonly pullError = signal<string | null>(null);

  protected readonly initAsking = signal(false);
  protected readonly initBusy = signal(false);
  /** Shown inside the open code modal (a wrong code leaves it open for a retry). */
  protected readonly totpError = signal<string | null>(null);
  protected readonly initError = signal<string | null>(null);
  protected readonly branch = signal<KyroBranchResult | null>(null);

  protected ready(): boolean {
    return this.project().status === 'ready';
  }

  protected summary(result: PullResult): string {
    return pullSummary(result);
  }

  protected branchText(result: KyroBranchResult): string {
    return kyroBranchSummary(result, this.project().baseBranch);
  }

  protected async pull(): Promise<void> {
    this.pulling.set(true);
    this.pullResult.set(null);
    this.pullError.set(null);
    try {
      this.pullResult.set(await this.service.pull(this.project().id));
    } catch (cause) {
      this.pullError.set(apiErrorMessage(cause));
    } finally {
      this.pulling.set(false);
    }
  }

  protected closeInit(): void {
    this.initAsking.set(false);
    this.totpError.set(null);
  }

  protected async initKyro(code: string): Promise<void> {
    this.initBusy.set(true);
    this.totpError.set(null);
    this.initError.set(null);
    this.branch.set(null);
    try {
      this.branch.set(await this.service.initKyro(this.project().id, code));
      this.initAsking.set(false);
    } catch (cause) {
      if (isInvalidTotp(cause)) {
        this.totpError.set(apiErrorMessage(cause));
      } else {
        this.initError.set(apiErrorMessage(cause));
        this.initAsking.set(false);
      }
    } finally {
      this.initBusy.set(false);
    }
  }
}
