import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { ChatKind, Project } from '@agents-panel/shared';
import { ChatsService, apiErrorMessage } from './chats.service';
import { Button } from '../ui/button';

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
  imports: [Button],
  template: `
    <form class="card" (submit)="submit($event)">
      <h2>Nuevo chat</h2>
      @if (blockedReason(); as reason) {
        <p class="hint" role="status">{{ reason }}</p>
      }

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
  private readonly router = inject(Router);

  /** The project the chat is created on; fixed by the page, never chosen here. */
  readonly project = input.required<Project>();

  protected readonly kind = signal<ChatKind>('work');
  protected readonly slug = signal('');
  protected readonly prompt = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

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

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected kindOf(event: Event): ChatKind {
    return this.text(event) === 'scope' ? 'scope' : 'work';
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canSubmit()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const chat = await this.chats.create({
        projectId: this.project().id,
        kind: this.kind(),
        slug: this.slug(),
        prompt: this.prompt().trim(),
      });
      await this.router.navigate(['/projects', chat.projectId, 'chats', chat.id]);
    } catch (cause) {
      // Keep everything typed so the user can fix the slug and retry.
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.busy.set(false);
    }
  }
}
