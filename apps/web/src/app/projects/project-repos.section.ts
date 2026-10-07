import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import type { Project, ProjectRepo, RepoPullResult } from '@agents-panel/shared';
import { apiErrorMessage } from '../chats/chats.service';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { ProjectsService } from './projects.service';
import { canSaveBase, mergeRepoRows, pullFailureOf, pullOutcomeOf, repoTitle } from './repos-logic';

/**
 * Configuración > Repositorio, clon base: the repos of the project with their editable base branch,
 * "Detectar repos" and one pull that updates each repo from its own base, with the result in its row.
 * The base clone only ever advances (fast-forward): there is no commit or install here.
 */
@Component({
  selector: 'app-project-repos',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Badge, Button],
  template: `
    <h3>Clon base</h3>
    <p class="hint">
      Los worktrees nuevos salen del clon de la VM, cada repo desde su rama base. Traé lo último de
      GitHub antes de empezar un trabajo. Solo avanza (fast-forward): si un repo tiene cambios
      locales o se desvió, no lo toca y lo marca.
    </p>
    <div class="flex flex-wrap items-center gap-2">
      <button appButton type="button" [disabled]="pulling() || !ready()" (click)="pull()">
        {{ pulling() ? 'Trayendo…' : 'Traer cambios de GitHub' }}
      </button>
      <button
        appButton
        variant="secondary"
        type="button"
        [disabled]="detecting() || pulling() || !ready()"
        (click)="detect()"
      >
        {{ detecting() ? 'Buscando…' : 'Detectar repos' }}
      </button>
    </div>
    @if (pullError(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }
    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }
    @if (rows().length === 0 && loaded()) {
      <p class="hint">Todavía no hay repos guardados: usá Detectar repos.</p>
    }
    <ul class="m-0 mt-3 flex list-none flex-col gap-2 p-0">
      @for (row of rows(); track row.repo.id) {
        <li class="rounded-card border border-border bg-surface p-3">
          <div class="flex flex-wrap items-center gap-2">
            <strong>{{ title(row.repo.path) }}</strong>
            @if (row.pull; as pull) {
              <app-badge [tone]="pull.tone">{{ pull.label }}</app-badge>
            }
          </div>
          <form class="mt-2 flex flex-wrap items-end gap-2" (submit)="save($event, row.repo)">
            <label class="flex flex-col gap-1 text-sm">
              Rama base
              <input
                class="rounded-control border border-border bg-surface px-2 py-1"
                [value]="baseOf(row.repo)"
                [attr.aria-label]="'Rama base de ' + title(row.repo.path)"
                (input)="type(row.repo.id, $event)"
              />
            </label>
            <button
              appButton
              variant="secondary"
              type="submit"
              [disabled]="savingId() === row.repo.id || !canSave(row.repo)"
            >
              {{ savingId() === row.repo.id ? 'Guardando…' : 'Guardar' }}
            </button>
          </form>
          @if (row.pull; as pull) {
            <p
              class="mt-2 mb-0 text-sm"
              [class]="pull.state === 'rejected' ? 'text-danger' : 'text-muted'"
              role="status"
            >
              {{ pull.detail }}
            </p>
          }
        </li>
      }
    </ul>
  `,
})
export class ProjectRepos {
  private readonly service = inject(ProjectsService);

  readonly project = input.required<Project>();
  /** The page reads the project again after a pull: Kyro may have arrived. */
  readonly refresh = output();

  protected readonly repos = signal<ProjectRepo[]>([]);
  protected readonly loaded = signal(false);
  protected readonly pulling = signal(false);
  protected readonly detecting = signal(false);
  protected readonly savingId = signal<number | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly pullError = signal<string | null>(null);
  private readonly pullResults = signal<RepoPullResult[] | null>(null);
  private readonly typed = signal<Record<number, string>>({});

  protected readonly rows = computed(() => mergeRepoRows(this.repos(), this.pullResults()));
  protected readonly title = repoTitle;

  constructor() {
    effect(() => {
      const id = this.project().id;
      untracked(() => {
        void this.load(id);
      });
    });
  }

  protected ready(): boolean {
    return this.project().status === 'ready';
  }

  protected baseOf(repo: ProjectRepo): string {
    return this.typed()[repo.id] ?? repo.baseBranch;
  }

  protected canSave(repo: ProjectRepo): boolean {
    return canSaveBase(repo.baseBranch, this.baseOf(repo));
  }

  protected type(repoId: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.typed.update((all) => ({ ...all, [repoId]: value }));
  }

  private async load(projectId: number): Promise<void> {
    try {
      const repos = await this.service.repos(projectId);
      if (projectId === this.project().id) this.repos.set(repos);
      this.error.set(null);
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.loaded.set(true);
    }
  }

  protected async detect(): Promise<void> {
    this.detecting.set(true);
    this.error.set(null);
    try {
      this.repos.set(await this.service.detectRepos(this.project().id));
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.detecting.set(false);
    }
  }

  protected async save(event: Event, repo: ProjectRepo): Promise<void> {
    event.preventDefault();
    if (!this.canSave(repo) || this.savingId() !== null) return;
    this.savingId.set(repo.id);
    this.error.set(null);
    try {
      const saved = await this.service.updateRepoBase(
        this.project().id,
        repo.id,
        this.baseOf(repo).trim(),
      );
      this.repos.update((all) => all.map((r) => (r.id === saved.id ? saved : r)));
      this.typed.update((all) =>
        Object.fromEntries(Object.entries(all).filter(([id]) => id !== String(repo.id))),
      );
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.savingId.set(null);
    }
  }

  /** One pull for every repo; when the root is rejected (409) the other rows still show. */
  protected async pull(): Promise<void> {
    this.pulling.set(true);
    this.pullResults.set(null);
    this.pullError.set(null);
    try {
      this.pullResults.set(pullOutcomeOf(await this.service.pull(this.project().id)).repos);
      this.refresh.emit();
    } catch (cause) {
      const failure = pullFailureOf(cause);
      if (failure) {
        this.pullResults.set(failure.repos);
        this.pullError.set(failure.error);
      } else {
        this.pullError.set(apiErrorMessage(cause));
      }
    } finally {
      this.pulling.set(false);
      // The pull saves the repos it found: show them even when no row existed yet.
      void this.load(this.project().id);
    }
  }
}
