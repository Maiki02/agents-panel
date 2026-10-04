import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import type { Project } from '@agents-panel/shared';
import { apiErrorMessage } from '../chats/chats.service';
import { Button } from '../ui/button';
import { Modal } from '../ui/modal';
import { ProjectsService } from './projects.service';
import { parseRepoInput } from './repo-input';

/** "Nuevo proyecto" modal: the full GitHub URL gives user, repo and base branch (R29). */
@Component({
  selector: 'app-add-project-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal, Button],
  template: `
    <app-modal heading="Nuevo proyecto" (closed)="closed.emit()">
      <form (submit)="submit($event)">
        <label for="repo">URL del repositorio de GitHub</label>
        <input
          id="repo"
          name="repo"
          autocomplete="off"
          placeholder="https://github.com/usuario/repo"
          data-autofocus
          [class.invalid]="repoProblem() !== null"
          [value]="repo()"
          (input)="repo.set(text($event))"
        />
        @if (repoProblem(); as message) {
          <span class="error" role="alert">{{ message }}</span>
        } @else if (detected(); as found) {
          <span class="hint">
            Repo: {{ found.slug }} · Rama: {{ found.branch ?? 'la predeterminada del repo' }}
          </span>
        }

        <label for="displayName">Nombre visible (opcional)</label>
        <input
          id="displayName"
          name="displayName"
          autocomplete="off"
          [value]="displayName()"
          (input)="displayName.set(text($event))"
        />

        @if (error(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }
        <button appButton type="submit" [disabled]="!canSubmit()">
          {{ busy() ? 'Agregando…' : 'Agregar' }}
        </button>
      </form>
    </app-modal>
  `,
})
export class AddProjectForm {
  private readonly service = inject(ProjectsService);

  readonly added = output<Project>();
  readonly closed = output();

  protected readonly repo = signal('');
  protected readonly displayName = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  private readonly parsed = computed(() => parseRepoInput(this.repo()));
  protected readonly repoProblem = computed(() => {
    const parsed = this.parsed();
    return this.repo().trim() === '' || parsed.ok ? null : parsed.reason;
  });
  protected readonly detected = computed(() => {
    const parsed = this.parsed();
    return parsed.ok ? parsed : null;
  });
  protected readonly canSubmit = computed(() => !this.busy() && this.parsed().ok);

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canSubmit()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const display = this.displayName().trim();
      const project = await this.service.add({
        repo: this.repo().trim(),
        ...(display === '' ? {} : { displayName: display }),
      });
      this.added.emit(project);
      this.closed.emit();
    } catch (cause) {
      // Stay open with what was typed (a 409 "ya existe" included) so it can be fixed.
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.busy.set(false);
    }
  }
}
