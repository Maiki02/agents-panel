import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import type { ModelRole, ModelSelection } from '@agents-panel/shared';
import { apiErrorMessage } from '../chats/chats.service';
import { Button } from '../ui/button';
import { ProjectsService } from './projects.service';
import { ROLE_TITLE, choiceOf, modelChoices, modelsChanged, selectionFrom } from './settings-logic';

/**
 * Configuración > Modelos: one model per role for the chats of this project. Only Claude exists
 * today; the provider is shown so adding another later does not change the screen. A chat can
 * still change them when it is created.
 */
@Component({
  selector: 'app-models-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Button],
  template: `
    @if (saved(); as current) {
      <form (submit)="save($event)">
        <label for="models-provider">Proveedor</label>
        <select id="models-provider" disabled>
          <option selected>
            {{ current.provider === 'claude' ? 'Claude' : current.provider }}
          </option>
        </select>
        @for (role of roles; track role) {
          <label [for]="'models-' + role">{{ title[role] }}</label>
          <select [id]="'models-' + role" (change)="pick(role, $event)">
            @for (option of options(role); track option.value) {
              <option [value]="option.value" [selected]="option.value === choice(role)">
                {{ option.label }}
              </option>
            }
          </select>
        }
        <p class="hint">
          El pensante planifica; el ejecutor ejecuta, corre QA y cierra. Cada paso abre una sesión
          nueva con el modelo de su rol.
        </p>
        <button appButton type="submit" [disabled]="busy() || !changed()">
          {{ busy() ? 'Guardando…' : 'Guardar' }}
        </button>
        @if (done()) {
          <p class="hint" role="status">Guardado.</p>
        }
        @if (error(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }
      </form>
    } @else if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    } @else {
      <p class="hint">Cargando…</p>
    }
  `,
})
export class ModelsSection {
  private readonly service = inject(ProjectsService);

  readonly projectId = input.required<number>();

  protected readonly roles: readonly ModelRole[] = ['thinker', 'executor'];
  protected readonly title = ROLE_TITLE;
  protected readonly saved = signal<ModelSelection | null>(null);
  protected readonly thinker = signal('');
  protected readonly executor = signal('');
  protected readonly busy = signal(false);
  protected readonly done = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly changed = computed(() => {
    const saved = this.saved();
    return saved !== null && modelsChanged(saved, this.draft());
  });

  constructor() {
    effect(() => {
      void this.load(this.projectId());
    });
  }

  private draft(): { thinker: string; executor: string } {
    return { thinker: this.thinker(), executor: this.executor() };
  }

  protected options(role: ModelRole) {
    return modelChoices(this.saved()?.provider ?? 'claude', role);
  }

  protected choice(role: ModelRole): string {
    return role === 'thinker' ? this.thinker() : this.executor();
  }

  protected pick(role: ModelRole, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    (role === 'thinker' ? this.thinker : this.executor).set(value);
    this.done.set(false);
  }

  private show(models: ModelSelection): void {
    this.saved.set(models);
    this.thinker.set(choiceOf('thinker', models.thinker));
    this.executor.set(choiceOf('executor', models.executor));
  }

  private async load(id: number): Promise<void> {
    this.saved.set(null);
    this.error.set(null);
    try {
      const models = await this.service.models(id);
      if (id === this.projectId()) this.show(models);
    } catch (cause) {
      if (id === this.projectId()) this.error.set(apiErrorMessage(cause));
    }
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    const saved = this.saved();
    if (saved === null || !this.changed()) return;
    this.busy.set(true);
    this.done.set(false);
    this.error.set(null);
    try {
      this.show(
        await this.service.saveModels(
          this.projectId(),
          selectionFrom(saved.provider, this.draft()),
        ),
      );
      this.done.set(true);
    } catch (cause) {
      // The draft stays as typed so it can be corrected.
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.busy.set(false);
    }
  }
}
