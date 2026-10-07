import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { apiErrorMessage } from '../chats/chats.service';
import { currentUrl } from '../shell/current-url';
import { projectSection } from '../shell/nav-logic';
import { PageTitleStore } from '../shell/page-title.store';
import { Badge } from '../ui/badge';
import { Tabs, type TabItem } from '../ui/tabs';
import { LastChatStore } from './last-chat.store';
import { selectionFromUrl } from './last-chat';
import { ProjectContext } from './project-context';
import {
  kyroPendingNotice,
  projectLabel,
  projectStatusLabel,
  projectStatusTone,
} from './project-label';
import { ProjectsService } from './projects.service';

/**
 * /projects/:id: "Chats" and "Configuración" tabs with the project status, and the child route
 * below filling the rest of the height. The project name goes to the header title. It also
 * remembers the selected chat per project, so coming back reopens it (R30).
 */
@Component({
  selector: 'app-project-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, Badge, Tabs],
  providers: [ProjectContext],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    @if (notFound()) {
      <p class="error" role="alert">Proyecto no encontrado.</p>
      <p class="hint">Elegí otro desde Proyectos, en el menú.</p>
    } @else {
      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
      @if (context.project(); as p) {
        <h1 class="sr-only">{{ label(p) }}</h1>
        <div class="flex shrink-0 items-center gap-3">
          <app-tabs
            class="min-w-0 flex-1"
            [tabs]="sections"
            [active]="section()"
            (selected)="open(p.id, $event)"
          />
          <app-badge class="shrink-0" [tone]="tone(p)">{{ statusText(p) }}</app-badge>
        </div>
        @if (pendingNotice(p); as notice) {
          <p class="hint mt-2 shrink-0" role="status">{{ notice }}</p>
        }
        <section class="mt-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          <router-outlet />
        </section>
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

  protected readonly sections: readonly TabItem[] = [
    { id: 'chats', label: 'Chats' },
    { id: 'settings', label: 'Configuración' },
  ];
  private readonly router = inject(Router);
  private readonly pageTitle = inject(PageTitleStore);
  private readonly url = currentUrl();
  protected readonly section = computed(() => projectSection(this.url()));
  protected readonly notFound = signal(false);
  protected readonly error = signal<string | null>(null);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.stopPolling();
      this.pageTitle.projectName.set(null);
    });
    effect(() => {
      void this.load(Number(this.id()));
    });
    this.router.events
      .pipe(
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
  protected pendingNotice = kyroPendingNotice;

  protected statusText(project: { status: Parameters<typeof projectStatusLabel>[0] }): string {
    return projectStatusLabel(project.status);
  }

  protected tone(project: { status: Parameters<typeof projectStatusTone>[0] }) {
    return projectStatusTone(project.status);
  }

  /** A tab is a route: Chats reopens the last chat (lastChatGuard), Configuración its first tab. */
  protected open(projectId: number, section: string): void {
    void this.router.navigate(['/projects', projectId, section]);
  }

  private async load(id: number): Promise<void> {
    this.notFound.set(false);
    if (!Number.isInteger(id) || id < 1) {
      this.notFound.set(true);
      this.pageTitle.projectName.set(null);
      return;
    }
    try {
      const project = await this.service.get(id);
      if (id !== Number(this.id())) return;
      this.context.project.set(project);
      this.pageTitle.projectName.set(projectLabel(project));
      this.error.set(null);
      this.syncPolling(id, project.status === 'cloning');
    } catch (cause) {
      if (cause instanceof HttpErrorResponse && cause.status === 404) {
        this.notFound.set(true);
        this.pageTitle.projectName.set(null);
      } else this.error.set(apiErrorMessage(cause));
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
