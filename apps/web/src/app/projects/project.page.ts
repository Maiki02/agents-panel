import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import type { Project, ProjectStatus } from '@agents-panel/shared';
import { ChatList } from '../chats/chat-list.page';
import { apiErrorMessage } from '../chats/chats.service';
import { NewChatForm } from '../chats/new-chat.form';
import { ProjectSettings } from './project-settings';
import { projectLabel } from './project-label';
import { ProjectsService } from './projects.service';

const STATUS_LABEL: Record<ProjectStatus, string> = {
  cloning: 'Clonando',
  ready: 'Listo',
  error: 'Error',
};

@Component({
  selector: 'app-project',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, NewChatForm, ChatList, ProjectSettings],
  template: `
    <p><a routerLink="/">← Proyectos</a></p>
    @if (notFound()) {
      <p class="error" role="alert">Proyecto no encontrado.</p>
      <a routerLink="/">Volver a Proyectos</a>
    } @else {
      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
      @if (project(); as p) {
        <header class="chat-head">
          <h1>{{ label(p) }}</h1>
          <span class="badge" [class]="'badge ' + badge(p)">{{ statusText(p) }}</span>
        </header>
        <app-new-chat-form [project]="p" />
        <app-chat-list [projectId]="p.id" />
        <app-project-settings [project]="p" (changed)="project.set($event)" />
      }
    }
  `,
})
export class ProjectPage {
  private readonly service = inject(ProjectsService);

  /** Route param `:id` (bound by withComponentInputBinding). */
  readonly id = input.required<string>();

  protected readonly project = signal<Project | null>(null);
  protected readonly notFound = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      void this.load(Number(this.id()));
    });
  }

  protected label(project: Project): string {
    return projectLabel(project);
  }

  protected statusText(project: Project): string {
    return STATUS_LABEL[project.status];
  }

  protected badge(project: Project): string {
    return project.status === 'ready' ? 'idle' : project.status === 'error' ? 'error' : 'running';
  }

  private async load(id: number): Promise<void> {
    this.notFound.set(false);
    if (!Number.isInteger(id) || id < 1) {
      this.notFound.set(true);
      return;
    }
    try {
      this.project.set(await this.service.get(id));
      this.error.set(null);
    } catch (cause) {
      if (cause instanceof HttpErrorResponse && cause.status === 404) this.notFound.set(true);
      else this.error.set(apiErrorMessage(cause));
    }
  }
}
