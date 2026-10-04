import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Project, ProjectStatus } from '@agents-panel/shared';
import { apiErrorMessage } from '../chats/chats.service';
import { AddProjectForm } from './add-project.form';
import { projectLabel } from './project-label';
import { ProjectsService } from './projects.service';

const POLL_MS = 3000;
const STATUS_LABEL: Record<ProjectStatus, string> = {
  cloning: 'Clonando',
  ready: 'Listo',
  error: 'Error',
};
const STATUS_BADGE: Record<ProjectStatus, string> = {
  cloning: 'running',
  ready: 'idle',
  error: 'error',
};

@Component({
  selector: 'app-projects',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, AddProjectForm],
  template: `
    <h2>Proyectos</h2>
    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }
    @for (project of projects(); track project.id) {
      <article class="card project-card">
        <a [routerLink]="['/projects', project.id]">{{ label(project) }}</a>
        <span [class]="'badge ' + badge(project)">{{ statusText(project) }}</span>
        <div class="meta">{{ repoName(project) }}</div>
        @if (project.status === 'error') {
          <p class="error">{{ project.statusDetail }}</p>
          <button type="button" (click)="retry(project)">Reintentar</button>
        }
        @if (project.status === 'ready' && !project.hasKyro) {
          <p class="hint">Proyecto sin Kyro: no hay /kyro-* hasta inicializarlo a mano.</p>
        }
        @if (project.kyroWarning; as warning) {
          <p class="hint">{{ warning }}</p>
        }
        @if (suggestion(project); as command) {
          <div class="suggestion">
            @if (editing() === project.id) {
              <label [for]="'setup-' + project.id">Comando de setup</label>
              <input
                [id]="'setup-' + project.id"
                autocomplete="off"
                [value]="draft()"
                (input)="draft.set(text($event))"
              />
              <button type="button" (click)="saveSetup(project, draft().trim() || null)">
                Guardar
              </button>
            } @else {
              <p>
                Setup sugerido: <code>{{ command }}</code>
              </p>
              <button type="button" (click)="saveSetup(project, command)">Confirmar</button>
              <button type="button" class="link" (click)="edit(project, command)">Editar</button>
              <button type="button" class="link" (click)="dismiss(project)">Sin setup</button>
            }
          </div>
        }
        @if (rowError(project.id); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }
      </article>
    } @empty {
      @if (loaded()) {
        <p class="hint">Todavía no hay proyectos. Agregá el primero desde abajo.</p>
      }
    }
    <app-add-project-form (added)="onAdded($event)" />
  `,
})
export class ProjectsPage {
  private readonly service = inject(ProjectsService);

  protected readonly projects = signal<Project[]>([]);
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Suggested setup per ready project without one (from GET /:id). */
  private readonly suggestions = signal<Record<number, string>>({});
  /** Projects whose suggestion the user dismissed ("Sin setup": nothing is saved). */
  private readonly dismissed = signal<ReadonlySet<number>>(new Set());
  private readonly rowErrors = signal<Record<number, string>>({});
  private readonly looked = new Set<number>();
  protected readonly editing = signal<number | null>(null);
  protected readonly draft = signal('');
  private readonly anyCloning = computed(() => this.projects().some((p) => p.status === 'cloning'));
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.stopPolling();
    });
    void this.load();
  }

  protected label(project: Project): string {
    return projectLabel(project);
  }

  protected statusText(project: Project): string {
    return STATUS_LABEL[project.status];
  }

  protected badge(project: Project): string {
    return STATUS_BADGE[project.status];
  }

  protected repoName(project: Project): string {
    return project.repoUrl?.replace('https://github.com/', '') ?? project.repoPath;
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected rowError(id: number): string | null {
    return this.rowErrors()[id] ?? null;
  }

  protected suggestion(project: Project): string | null {
    if (project.status !== 'ready' || project.setupCommand !== null) return null;
    if (this.dismissed().has(project.id)) return null;
    return this.suggestions()[project.id] ?? null;
  }

  protected onAdded(project: Project): void {
    this.projects.update((list) => [...list.filter((p) => p.id !== project.id), project]);
    void this.refresh();
  }

  protected edit(project: Project, command: string): void {
    this.draft.set(command);
    this.editing.set(project.id);
  }

  protected dismiss(project: Project): void {
    this.dismissed.update((set) => new Set(set).add(project.id));
  }

  protected async retry(project: Project): Promise<void> {
    this.setRowError(project.id, null);
    try {
      this.replace(await this.service.retry(project.id));
      this.syncPolling();
    } catch (cause) {
      this.setRowError(project.id, apiErrorMessage(cause));
    }
  }

  /** Nothing is saved until the user confirms; an empty edit means "no setup" (null). */
  protected async saveSetup(project: Project, command: string | null): Promise<void> {
    this.setRowError(project.id, null);
    try {
      const saved = await this.service.patch(project.id, { setupCommand: command });
      this.replace(saved);
      this.editing.set(null);
      if (command === null) this.dismiss(project);
    } catch (cause) {
      this.setRowError(project.id, apiErrorMessage(cause));
    }
  }

  private replace(project: Project): void {
    this.projects.update((list) => list.map((p) => (p.id === project.id ? project : p)));
  }

  private setRowError(id: number, message: string | null): void {
    this.rowErrors.update((errors) => {
      const rest = Object.fromEntries(Object.entries(errors).filter(([key]) => Number(key) !== id));
      return message === null ? rest : { ...rest, [id]: message };
    });
  }

  private async load(): Promise<void> {
    try {
      await this.refresh();
    } finally {
      this.loaded.set(true);
    }
  }

  private async refresh(): Promise<void> {
    try {
      this.projects.set(await this.service.list());
      this.error.set(null);
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
      return;
    }
    this.syncPolling();
    await this.lookForSuggestions();
  }

  /** Polls only while some project is cloning; stops as soon as none is (and on destroy). */
  private syncPolling(): void {
    if (this.anyCloning()) {
      this.timer ??= setInterval(() => void this.refresh(), POLL_MS);
    } else {
      this.stopPolling();
    }
  }

  private stopPolling(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Asks GET /:id once per ready project that has no setup yet. */
  private async lookForSuggestions(): Promise<void> {
    for (const project of this.projects()) {
      if (project.status !== 'ready' || project.setupCommand !== null) continue;
      if (this.looked.has(project.id)) continue;
      this.looked.add(project.id);
      try {
        const detail = await this.service.get(project.id);
        if (detail.suggestedSetupCommand !== null) {
          const command = detail.suggestedSetupCommand;
          this.suggestions.update((s) => ({ ...s, [project.id]: command }));
        }
      } catch {
        this.looked.delete(project.id);
      }
    }
  }
}
