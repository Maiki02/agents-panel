import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { DeleteBlocker, Project } from '@agents-panel/shared';
import { apiErrorMessage, isInvalidTotp } from '../chats/chats.service';
import { Button } from '../ui/button';
import { DeleteProjectModal } from './delete-project.modal';
import { projectLabel } from './project-label';
import { deleteBlockers } from './repo-actions';
import { ProjectsService } from './projects.service';

/** General > zona de peligro: delete the project (clone, worktrees, chats and .env) from the VM. */
@Component({
  selector: 'app-project-danger-zone',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Button, DeleteProjectModal],
  template: `
    <h3 class="pt-4">Zona de peligro</h3>
    <p class="hint">
      Borrar el proyecto elimina su clon y sus worktrees de la VM, los chats y los .env cifrados. No
      toca GitHub.
    </p>
    <button appButton variant="danger" type="button" (click)="open()">Borrar proyecto…</button>
    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }
    @if (asking()) {
      <app-delete-project-modal
        [label]="label()"
        [busy]="busy()"
        [error]="modalError()"
        [blockers]="blockers()"
        (submitted)="confirm($event)"
        (closed)="close()"
      />
    }
  `,
})
export class ProjectDangerZone {
  private readonly service = inject(ProjectsService);
  private readonly router = inject(Router);

  readonly project = input.required<Project>();

  protected readonly asking = signal(false);
  protected readonly busy = signal(false);
  protected readonly modalError = signal<string | null>(null);
  protected readonly blockers = signal<DeleteBlocker[]>([]);
  protected readonly error = signal<string | null>(null);

  protected label(): string {
    return projectLabel(this.project());
  }

  protected open(): void {
    this.error.set(null);
    this.modalError.set(null);
    this.blockers.set([]);
    this.asking.set(true);
  }

  protected close(): void {
    this.asking.set(false);
    this.modalError.set(null);
    this.blockers.set([]);
  }

  protected async confirm(input: { name: string; code: string }): Promise<void> {
    this.busy.set(true);
    this.modalError.set(null);
    this.blockers.set([]);
    try {
      await this.service.remove(this.project().id, input.name, input.code);
      this.asking.set(false);
      await this.router.navigateByUrl('/');
    } catch (cause) {
      if (isInvalidTotp(cause)) {
        this.modalError.set(apiErrorMessage(cause));
      } else {
        // A refusal explains itself inside the modal; the user fixes it and tries again.
        this.modalError.set(apiErrorMessage(cause));
        this.blockers.set(deleteBlockers(cause));
      }
    } finally {
      this.busy.set(false);
    }
  }
}
