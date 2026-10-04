import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { apiErrorMessage } from '../chats/chats.service';
import { Badge } from '../ui/badge';
import { LastChatStore } from './last-chat.store';
import { selectionFromUrl } from './last-chat';
import { ProjectContext } from './project-context';
import { projectLabel, projectStatusLabel, projectStatusTone } from './project-label';
import { ProjectsService } from './projects.service';

/**
 * /projects/:id: a side rail with "Chats" and "Configuración" and the child route next to it.
 * It also remembers the selected chat per project, so coming back reopens it (R30).
 */
@Component({
  selector: 'app-project-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, RouterOutlet, Badge],
  providers: [ProjectContext],
  template: `
    <p><a routerLink="/">← Proyectos</a></p>
    @if (notFound()) {
      <p class="error" role="alert">Proyecto no encontrado.</p>
      <a routerLink="/">Volver a Proyectos</a>
    } @else {
      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
      @if (context.project(); as p) {
        <header class="chat-head mb-4">
          <h1>{{ label(p) }}</h1>
          <app-badge [tone]="tone(p)">{{ statusText(p) }}</app-badge>
        </header>
        <div class="grid gap-4 md:grid-cols-[11rem_minmax(0,1fr)]">
          <nav class="flex gap-1 md:flex-col" aria-label="Secciones del proyecto">
            @for (item of sections; track item.path) {
              <a
                [routerLink]="['/projects', p.id, item.path]"
                routerLinkActive="!bg-surface-raised !text-text font-semibold"
                class="rounded-control px-3 py-2 text-sm text-muted hover:bg-surface-raised hover:text-text hover:no-underline"
              >
                {{ item.label }}
              </a>
            }
          </nav>
          <section class="min-w-0">
            <router-outlet />
          </section>
        </div>
      }
    }
  `,
})
export class ProjectLayout {
  private readonly service = inject(ProjectsService);
  private readonly lastChat = inject(LastChatStore);
  protected readonly context = inject(ProjectContext);

  /** Route param `:id` (bound by withComponentInputBinding). */
  readonly id = input.required<string>();

  protected readonly sections = [
    { path: 'chats', label: 'Chats' },
    { path: 'settings', label: 'Configuración' },
  ] as const;
  protected readonly notFound = signal(false);
  protected readonly error = signal<string | null>(null);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.stopPolling();
    });
    effect(() => {
      void this.load(Number(this.id()));
    });
    inject(Router)
      .events.pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe((event) => {
        const selection = selectionFromUrl(event.urlAfterRedirects);
        if (selection) {
          this.lastChat.set(selection.projectId, selection.chat === 'new' ? null : selection.chat);
        }
      });
  }

  protected label = projectLabel;

  protected statusText(project: { status: Parameters<typeof projectStatusLabel>[0] }): string {
    return projectStatusLabel(project.status);
  }

  protected tone(project: { status: Parameters<typeof projectStatusTone>[0] }) {
    return projectStatusTone(project.status);
  }

  private async load(id: number): Promise<void> {
    this.notFound.set(false);
    if (!Number.isInteger(id) || id < 1) {
      this.notFound.set(true);
      return;
    }
    try {
      const project = await this.service.get(id);
      if (id !== Number(this.id())) return;
      this.context.project.set(project);
      this.error.set(null);
      this.syncPolling(id, project.status === 'cloning');
    } catch (cause) {
      if (cause instanceof HttpErrorResponse && cause.status === 404) this.notFound.set(true);
      else this.error.set(apiErrorMessage(cause));
    }
  }

  /** While the project is cloning, re-read it so the new-chat form unlocks without reloading. */
  private syncPolling(id: number, cloning: boolean): void {
    if (cloning) {
      this.timer ??= setInterval(() => void this.load(id), 3000);
    } else {
      this.stopPolling();
    }
  }

  private stopPolling(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
