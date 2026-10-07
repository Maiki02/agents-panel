import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Project } from '@agents-panel/shared';
import { apiErrorMessage } from '../chats/chats.service';
import { AddProjectForm } from './add-project.form';
import {
  kyroPendingNotice,
  projectLabel,
  projectStatusLabel,
  projectStatusTone,
  repoDisplay,
} from './project-label';
import { CapacityBars } from './capacity-bars';
import { projectDiskText } from './capacity-logic';
import { CapacityService } from './capacity.service';
import { ProjectsService } from './projects.service';
import { Button } from '../ui/button';
import { Icon } from '../ui/icon';
import { Badge } from '../ui/badge';
import type { BadgeTone } from '../ui/badge';

const POLL_MS = 3000;

@Component({
  selector: 'app-projects',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, AddProjectForm, Button, Badge, Icon, CapacityBars],
  template: `
    <div class="mb-4 flex items-center justify-between gap-3">
      <h2 class="m-0">Proyectos</h2>
      <button appButton type="button" (click)="adding.set(true)">
        <app-icon name="plus" />
        Nuevo proyecto
      </button>
    </div>
    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }
    <app-capacity-bars />
    @for (project of projects(); track project.id) {
      <article class="card project-card">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <a [routerLink]="['/projects', project.id]" class="font-semibold">
              {{ label(project) }}
            </a>
            <div class="meta">
              @if (repo(project); as r) {
                @if (r.url) {
                  <a [href]="r.url" target="_blank" rel="noopener noreferrer" class="break-all">
                    {{ r.text }}
                  </a>
                } @else {
                  <span class="break-all">{{ r.text }}</span>
                }
                @if (r.branch) {
                  <span> · rama {{ r.branch }}</span>
                }
              }
            </div>
            <div class="meta">{{ diskText(project) }}</div>
          </div>
          <app-badge class="shrink-0" [tone]="tone(project)">{{ statusText(project) }}</app-badge>
        </div>
        @if (project.status === 'error') {
          <p class="error">{{ project.statusDetail }}</p>
          <button appButton type="button" (click)="retry(project)">Reintentar</button>
        }
        @if (project.status === 'ready' && !project.hasKyro) {
          <p class="hint">
            Proyecto sin Kyro: solo admite pedidos directos hasta inicializarlo (Configuración →
            Repositorio).
          </p>
        }
        @if (pendingNotice(project); as notice) {
          <p class="hint" role="status">{{ notice }}</p>
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
              <button appButton type="button" (click)="saveSetup(project, draft().trim() || null)">
                Guardar
              </button>
            } @else {
              <p>
                Setup sugerido: <code>{{ command }}</code>
              </p>
              <button appButton type="button" (click)="saveSetup(project, command)">
                Confirmar
              </button>
              <button appButton variant="secondary" type="button" (click)="edit(project, command)">
                Editar
              </button>
              <button appButton variant="secondary" type="button" (click)="dismiss(project)">
                Sin setup
              </button>
            }
          </div>
        }
        @if (rowError(project.id); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }
      </article>
    } @empty {
      @if (loaded()) {
        <p class="hint">Todavía no hay proyectos. Agregá el primero con «Nuevo proyecto».</p>
      }
    }
    @if (adding()) {
      <app-add-project-form (added)="onAdded($event)" (closed)="adding.set(false)" />
    }
  `,
})
export class ProjectsPage {
  private readonly service = inject(ProjectsService);
  private readonly capacity = inject(CapacityService);

  protected readonly projects = signal<Project[]>([]);
  protected readonly loaded = signal(false);
  protected readonly adding = signal(false);
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

  protected pendingNotice = kyroPendingNotice;

  protected diskText(project: Project): string {
    const entry = this.capacity.disk()?.projects.find((p) => p.name === project.name);
    return projectDiskText(this.capacity.diskState(), entry);
  }

  protected label(project: Project): string {
    return projectLabel(project);
  }

  protected statusText(project: Project): string {
    return projectStatusLabel(project.status);
  }

  protected tone(project: Project): BadgeTone {
    return projectStatusTone(project.status);
  }

  protected repo(project: Project): ReturnType<typeof repoDisplay> {
    return repoDisplay(project);
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
