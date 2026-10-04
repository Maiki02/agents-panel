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
import { parseRepoInput } from './repo-input';
import { ProjectsService } from './projects.service';

@Component({
  selector: 'app-add-project-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="card" (submit)="submit($event)">
      <h2>Agregar proyecto</h2>
      <label for="repo">Repositorio de GitHub (owner/repo o URL)</label>
      <input
        id="repo"
        name="repo"
        autocomplete="off"
        placeholder="mi-org/mi-repo"
        [class.invalid]="repoProblem() !== null"
        [value]="repo()"
        (input)="repo.set(text($event))"
      />
      @if (repoProblem(); as message) {
        <span class="error" role="alert">{{ message }}</span>
      }

      <label for="displayName">Nombre visible (opcional)</label>
      <input
        id="displayName"
        name="displayName"
        autocomplete="off"
        [value]="displayName()"
        (input)="displayName.set(text($event))"
      />

      <button type="submit" [disabled]="!canSubmit()">
        {{ busy() ? 'Agregando…' : 'Agregar' }}
      </button>
      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
    </form>
  `,
})
export class AddProjectForm {
  private readonly service = inject(ProjectsService);

  readonly added = output<Project>();

  protected readonly repo = signal('');
  protected readonly displayName = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly repoProblem = computed(() => {
    if (this.repo().trim() === '') return null;
    const parsed = parseRepoInput(this.repo());
    return parsed.ok ? null : parsed.reason;
  });
  protected readonly canSubmit = computed(
    () => !this.busy() && this.repo().trim() !== '' && this.repoProblem() === null,
  );

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
      this.repo.set('');
      this.displayName.set('');
      this.added.emit(project);
    } catch (cause) {
      // Keep what was typed (a 409 "ya existe" included) so it can be fixed.
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.busy.set(false);
    }
  }
}
