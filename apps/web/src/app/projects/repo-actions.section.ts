import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { KyroBranchResult, Project } from '@agents-panel/shared';
import { apiErrorMessage, isInvalidTotp } from '../chats/chats.service';
import { TotpModal } from '../shared/totp-modal';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { kyroBranchSummary, kyroInitView } from './repo-actions';
import { ProjectRepos } from './project-repos.section';
import { ProjectsService } from './projects.service';

/** Configuración > Repositorio: bring GitHub into the base clone and add Kyro on its own branch. */
@Component({
  selector: 'app-repo-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Badge, Button, ProjectRepos, TotpModal],
  template: `
    <app-project-repos [project]="project()" (refresh)="refresh.emit()" />

    <div class="flex flex-wrap items-center gap-2 pt-4">
      <h3 class="m-0">Kyro</h3>
      @if (kyro().chip; as chip) {
        <app-badge tone="warn">{{ chip }}</app-badge>
      }
    </div>
    @if (kyro().state === 'has_kyro') {
      <p class="hint">Este proyecto ya tiene Kyro.</p>
    } @else {
      @if (kyro().state === 'pending') {
        <p class="hint">
          La inicialización ya está hecha en la rama chore/kyro-init de la VM, pero el proyecto
          sigue sin Kyro hasta que esa rama llegue a {{ project().baseBranch }}. Falta:
        </p>
        <ol class="hint m-0 pl-5">
          @for (step of kyro().steps; track step) {
            <li>{{ step }}</li>
          }
        </ol>
      } @else {
        <p class="hint">
          Este proyecto no tiene Kyro, así que solo admite pedidos directos. Inicializarlo crea la
          rama chore/kyro-init en su propio worktree, con un commit; el clon base no se toca.
        </p>
      }
      <div class="flex flex-wrap items-center gap-2">
        <button
          appButton
          type="button"
          [disabled]="initBusy() || !kyro().canInit"
          [title]="kyro().initReason ?? ''"
          (click)="initAsking.set(true)"
        >
          Inicializar Kyro
        </button>
        @if (kyro().canPush) {
          <button
            appButton
            variant="secondary"
            type="button"
            [disabled]="pushing()"
            (click)="pushBranch()"
          >
            {{ pushing() ? 'Subiendo…' : 'Subir la rama a GitHub' }}
          </button>
        }
        @if (kyro().state === 'pending' && prLink(); as link) {
          <a class="link" [href]="link" target="_blank" rel="noopener noreferrer"
            >Abrir la PR en GitHub</a
          >
        }
        @if (kyro().state === 'pending') {
          <button appButton variant="secondary" type="button" (click)="refresh.emit()">
            Ya mergeé: actualizar
          </button>
        }
      </div>
      @if (kyro().initReason; as why) {
        @if (kyro().state === 'pending') {
          <p class="hint" role="status">{{ why }}</p>
        }
      }
    }
    @if (pushError(); as message) {
      <p class="error" role="alert">{{ message }}</p>
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
  /** The page reads the project again (after a pull or "ya mergeé"): Kyro may have arrived. */
  readonly refresh = output();

  protected readonly initAsking = signal(false);
  protected readonly initBusy = signal(false);
  /** Shown inside the open code modal (a wrong code leaves it open for a retry). */
  protected readonly totpError = signal<string | null>(null);
  protected readonly initError = signal<string | null>(null);
  protected readonly branch = signal<KyroBranchResult | null>(null);
  protected readonly pushing = signal(false);
  protected readonly pushedNow = signal(false);
  protected readonly pushError = signal<string | null>(null);
  private readonly pushedLink = signal<string | null>(null);
  protected readonly kyro = computed(() => kyroInitView(this.project(), this.pushedNow()));
  protected readonly prLink = computed(() => this.pushedLink() ?? this.kyro().prUrl);

  protected branchText(result: KyroBranchResult): string {
    return kyroBranchSummary(result, this.project().baseBranch);
  }

  protected async pushBranch(): Promise<void> {
    this.pushing.set(true);
    this.pushError.set(null);
    try {
      const result = await this.service.pushKyroInit(this.project().id);
      this.pushedNow.set(true);
      this.pushedLink.set(result.prUrl);
    } catch (cause) {
      this.pushError.set(apiErrorMessage(cause));
    } finally {
      this.pushing.set(false);
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
      this.refresh.emit();
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
