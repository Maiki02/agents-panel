import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { Project } from '@agents-panel/shared';
import { apiErrorMessage } from '../chats/chats.service';
import { failedField, validateCommandValue } from './settings-logic';
import { ProjectsService } from './projects.service';
import { Button } from '../ui/button';

@Component({
  selector: 'app-project-general',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Button],
  template: `
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
      <label for="cfg-validate">Comando de validación (vacío = sin validación)</label>
      <input
        id="cfg-validate"
        autocomplete="off"
        placeholder="npm run build"
        [class.invalid]="validateProblem() !== null || fieldError() === 'validate'"
        [value]="validateCommand()"
        (input)="validateCommand.set(text($event))"
      />
      <p class="hint">
        Lo corre el piloto en el worktree, sin shell y con un tiempo máximo, antes de abrir la PR.
        Si falla, frena y no abre la PR. Sin comando, el merge no valida y el Timeline lo anota.
      </p>
      @if (validateProblem(); as problem) {
        <span class="error" role="alert">{{ problem }}</span>
      } @else if (fieldError() === 'validate' && error(); as message) {
        <span class="error" role="alert">{{ message }}</span>
      }
      <button
        appButton
        type="submit"
        [disabled]="busy() || baseBranch().trim() === '' || validateProblem() !== null"
      >
        {{ busy() ? 'Guardando…' : 'Guardar' }}
      </button>
      @if (saved()) {
        <p class="hint" role="status">Guardado.</p>
      }
      @if (fieldError() === 'form' && error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
    </form>
  `,
})
export class ProjectGeneralSettings {
  private readonly service = inject(ProjectsService);

  readonly project = input.required<Project>();
  readonly changed = output<Project>();

  protected readonly displayName = signal('');
  protected readonly baseBranch = signal('');
  protected readonly setupCommand = signal('');
  protected readonly validateCommand = signal('');
  protected readonly validateProblem = computed(
    () => validateCommandValue(this.validateCommand()).problem,
  );
  /** Field a failed save is shown next to; the form itself when it cannot be told. */
  protected readonly fieldError = signal<'validate' | 'setup' | 'form'>('form');
  protected readonly busy = signal(false);
  protected readonly saved = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      const p = this.project();
      this.displayName.set(p.displayName ?? '');
      this.baseBranch.set(p.baseBranch);
      this.setupCommand.set(p.setupCommand ?? '');
      this.validateCommand.set(p.validateCommand ?? '');
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
      const validate = validateCommandValue(this.validateCommand()).value;
      const command = setup === '' ? null : setup;
      const project = this.project();
      this.fieldError.set(
        failedField(
          { setupCommand: project.setupCommand, validateCommand: project.validateCommand },
          { setupCommand: command, validateCommand: validate },
        ),
      );
      const updated = await this.service.patch(project.id, {
        displayName: display === '' ? null : display,
        baseBranch: this.baseBranch().trim(),
        setupCommand: command,
        validateCommand: validate,
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
