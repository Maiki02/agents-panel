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
import { RouterLink } from '@angular/router';
import type { Chat, ChatKind, Project } from '@agents-panel/shared';
import { ChatsService, apiErrorMessage } from './chats.service';
import { NewChatDraft } from './new-chat.draft';
import { Button } from '../ui/button';
import { settingsTabPath } from '../projects/settings-tabs';
import {
  availableKinds,
  effectiveKind,
  kindDescription,
  modelLabel,
  modelOptions,
  newChatInput,
  parseKind,
  pilotSwitch,
} from './chat-kinds';

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SLUG_LENGTH = 50;

export function slugProblem(slug: string): string | null {
  if (slug === '') return null;
  if (slug.length > MAX_SLUG_LENGTH) return `Máximo ${String(MAX_SLUG_LENGTH)} caracteres.`;
  if (!SLUG_PATTERN.test(slug)) return 'Usá minúsculas, números y guiones (kebab-case).';
  return null;
}

@Component({
  selector: 'app-new-chat-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Button, RouterLink],
  template: `
    <form class="!m-0 !border-0 !p-0 !shadow-none" (submit)="submit($event)">
      @if (blockedReason(); as reason) {
        <p class="hint" role="status">{{ reason }}</p>
      }

      <label for="kind">Tipo</label>
      <select id="kind" [value]="chosenKind()" (change)="kind.set(kindOf($event))">
        @for (option of kinds(); track option.kind) {
          <option [value]="option.kind" [selected]="option.kind === chosenKind()">
            {{ option.label }}
          </option>
        }
      </select>
      <p class="hint" data-testid="kind-description">{{ description() }}</p>
      @if (!project().hasKyro) {
        <p class="hint" role="status">
          Este proyecto no tiene Kyro: solo admite pedidos directos.
          <a class="link" [routerLink]="kyroInitPath()">Inicializar Kyro</a>
        </p>
      }

      <label for="slug">Nombre corto (slug)</label>
      <input
        id="slug"
        name="slug"
        autocomplete="off"
        placeholder="arreglar-login"
        [class.invalid]="slugError() !== null"
        [value]="slug()"
        (input)="slug.set(text($event))"
      />
      @if (slugError(); as message) {
        <span class="error" role="alert">{{ message }}</span>
      }

      <label for="prompt">Pedido</label>
      <textarea
        id="prompt"
        name="prompt"
        rows="4"
        [value]="prompt()"
        (input)="prompt.set(text($event))"
      ></textarea>

      <label class="flex items-center gap-2" for="autopilot">
        <input
          id="autopilot"
          name="autopilot"
          type="checkbox"
          [checked]="pilotOn()"
          [disabled]="!pilot().available"
          (change)="autopilot.set(checked($event))"
        />
        Piloto automático
      </label>
      @if (pilot().reason; as why) {
        <p class="hint" data-testid="pilot-reason">{{ why }}</p>
      } @else {
        <p class="hint">
          Lleva el trabajo solo hasta la PR y frena cuando necesita una decisión tuya.
        </p>
      }

      <details class="my-2">
        <summary>Opciones: modelos</summary>
        <label for="thinker">Modelo pensante (idea y plan)</label>
        <select id="thinker" (change)="thinker.set(text($event))">
          @for (option of models(); track option.id) {
            <option [value]="option.id" [selected]="option.id === thinkerModel()">
              {{ label(option.id, option.byDefault.thinker) }}
            </option>
          }
        </select>
        <label for="executor">Modelo ejecutor (ejecución, QA y cierre)</label>
        <select id="executor" (change)="executor.set(text($event))">
          @for (option of models(); track option.id) {
            <option [value]="option.id" [selected]="option.id === executorModel()">
              {{ label(option.id, option.byDefault.executor) }}
            </option>
          }
        </select>
      </details>

      <button appButton type="submit" [disabled]="!canSubmit()">
        {{ busy() ? 'Creando…' : 'Crear' }}
      </button>
      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
    </form>
  `,
})
export class NewChatForm {
  private readonly chats = inject(ChatsService);
  private readonly draft = inject(NewChatDraft);

  /** The project the chat is created on; fixed by the page, never chosen here. */
  readonly project = input.required<Project>();
  /** The chat was created; the host closes the dialog and opens it. */
  readonly created = output<Chat>();

  // What is typed lives in the draft, so closing the dialog does not lose it.
  protected readonly kind = this.draft.kind;
  protected readonly slug = this.draft.slug;
  protected readonly prompt = this.draft.prompt;
  protected readonly autopilot = this.draft.autopilot;
  protected readonly thinker = this.draft.thinker;
  protected readonly executor = this.draft.executor;
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly kinds = computed(() => availableKinds(this.project()));
  protected readonly chosenKind = computed(() => effectiveKind(this.project(), this.kind()));
  protected readonly description = computed(() => kindDescription(this.chosenKind()));
  protected readonly kyroInitPath = computed(() =>
    settingsTabPath(this.project().id, 'repository'),
  );
  protected readonly pilot = computed(() => pilotSwitch(this.chosenKind()));
  protected readonly pilotOn = computed(() => this.pilot().available && this.autopilot());
  protected readonly models = computed(() => modelOptions(this.project()));
  protected readonly thinkerModel = computed(() => this.thinker() ?? this.project().models.thinker);
  protected readonly executorModel = computed(
    () => this.executor() ?? this.project().models.executor,
  );
  protected readonly slugError = computed(() => slugProblem(this.slug()));
  /** Why the form is disabled; null while the project is ready (R7). */
  protected readonly blockedReason = computed(() => {
    const project = this.project();
    if (project.status === 'cloning')
      return 'El proyecto se está clonando: esperá a que esté listo.';
    if (project.status === 'error') {
      return `El proyecto no está listo (${project.statusDetail ?? 'error'}). Reintentá desde Proyectos.`;
    }
    return null;
  });
  protected readonly canSubmit = computed(
    () =>
      !this.busy() &&
      this.blockedReason() === null &&
      this.slug() !== '' &&
      this.slugError() === null &&
      this.prompt().trim() !== '',
  );

  constructor() {
    effect(() => {
      this.draft.use(this.project().id);
    });
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected label(id: string, isDefault: boolean): string {
    return modelLabel(id, isDefault);
  }

  protected kindOf(event: Event): ChatKind {
    return parseKind(this.text(event));
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canSubmit()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const chat = await this.chats.create(
        newChatInput(this.project(), this.kind(), this.slug(), this.prompt(), {
          autopilot: this.pilotOn(),
          models: { thinker: this.thinkerModel(), executor: this.executorModel() },
        }),
      );
      this.draft.reset();
      this.created.emit(chat);
    } catch (cause) {
      // Keep everything typed so the user can fix the slug and retry.
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.busy.set(false);
    }
  }
}
