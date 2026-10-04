import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { Project } from '@agents-panel/shared';
import { apiErrorMessage } from '../chats/chats.service';
import { EnvFilesSection } from './env-files.section';
import { ProjectsService } from './projects.service';

@Component({
  selector: 'app-project-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EnvFilesSection],
  template: `
    <section class="card">
      <h2>Configuración</h2>
      <form (submit)="save($event)">
        <label for="cfg-display">Nombre visible</label>
        <input
          id="cfg-display"
          autocomplete="off"
          [value]="displayName()"
          (input)="displayName.set(text($event))"
        />
        <label for="cfg-branch">Rama base</label>
        <input
          id="cfg-branch"
          autocomplete="off"
          [value]="baseBranch()"
          (input)="baseBranch.set(text($event))"
        />
        <label for="cfg-setup">Comando de setup (vacío = sin setup)</label>
        <input
          id="cfg-setup"
          autocomplete="off"
          [value]="setupCommand()"
          (input)="setupCommand.set(text($event))"
        />
        <button type="submit" [disabled]="busy() || baseBranch().trim() === ''">
          {{ busy() ? 'Guardando…' : 'Guardar' }}
        </button>
        @if (saved()) {
          <p class="hint" role="status">Guardado.</p>
        }
        @if (error(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }
      </form>
      <app-env-files-section [projectId]="project().id" />
    </section>
  `,
})
export class ProjectSettings {
  private readonly service = inject(ProjectsService);

  readonly project = input.required<Project>();
  readonly changed = output<Project>();

  protected readonly displayName = signal('');
  protected readonly baseBranch = signal('');
  protected readonly setupCommand = signal('');
  protected readonly busy = signal(false);
  protected readonly saved = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      const p = this.project();
      this.displayName.set(p.displayName ?? '');
      this.baseBranch.set(p.baseBranch);
      this.setupCommand.set(p.setupCommand ?? '');
    });
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    this.busy.set(true);
    this.saved.set(false);
    this.error.set(null);
    try {
      const display = this.displayName().trim();
      const setup = this.setupCommand().trim();
      const updated = await this.service.patch(this.project().id, {
        displayName: display === '' ? null : display,
        baseBranch: this.baseBranch().trim(),
        setupCommand: setup === '' ? null : setup,
      });
      this.changed.emit(updated);
      this.saved.set(true);
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.busy.set(false);
    }
  }
}
