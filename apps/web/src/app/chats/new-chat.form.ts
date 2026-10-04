import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { ChatKind, Project } from '@agents-panel/shared';
import { ChatsService, apiErrorMessage } from './chats.service';

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
  template: `
    <form class="card" (submit)="submit($event)">
      <h2>Nuevo pedido</h2>
      <label for="project">Proyecto</label>
      <select id="project" [value]="projectId() ?? ''" (change)="projectId.set(toNumber($event))">
        @for (p of projects(); track p.id) {
          <option [value]="p.id">{{ p.name }}</option>
        } @empty {
          <option value="">No hay proyectos registrados</option>
        }
      </select>

      <label for="kind">Tipo</label>
      <select id="kind" [value]="kind()" (change)="kind.set(kindOf($event))">
        <option value="work">Work (cambio chico)</option>
        <option value="scope">Scope (etapa grande)</option>
      </select>

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

      <button type="submit" [disabled]="!canSubmit()">
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
  private readonly router = inject(Router);

  protected readonly projects = signal<Project[]>([]);
  protected readonly projectId = signal<number | null>(null);
  protected readonly kind = signal<ChatKind>('work');
  protected readonly slug = signal('');
  protected readonly prompt = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly slugError = computed(() => slugProblem(this.slug()));
  protected readonly canSubmit = computed(
    () =>
      !this.busy() &&
      this.projectId() !== null &&
      this.slug() !== '' &&
      this.slugError() === null &&
      this.prompt().trim() !== '',
  );

  constructor() {
    void this.loadProjects();
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected toNumber(event: Event): number | null {
    const value = Number(this.text(event));
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  protected kindOf(event: Event): ChatKind {
    return this.text(event) === 'scope' ? 'scope' : 'work';
  }

  private async loadProjects(): Promise<void> {
    try {
      const list = await this.chats.projects();
      this.projects.set(list);
      this.projectId.set(list[0]?.id ?? null);
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    }
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    const projectId = this.projectId();
    if (projectId === null || !this.canSubmit()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const chat = await this.chats.create({
        projectId,
        kind: this.kind(),
        slug: this.slug(),
        prompt: this.prompt().trim(),
      });
      await this.router.navigate(['/chats', chat.id]);
    } catch (cause) {
      // Keep everything typed so the user can fix the slug and retry.
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.busy.set(false);
    }
  }
}
