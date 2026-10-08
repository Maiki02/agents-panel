import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ChatsService, apiErrorMessage } from './chats.service';

/** /chats/:id (old link): looks up the chat's project and goes to /projects/:p/chats/:id. */
@Component({
  selector: 'app-chat-redirect',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
      <a class="link" routerLink="/">Ir a Proyectos</a>
    } @else {
      <p class="hint">Abriendo el chat…</p>
    }
  `,
})
export class ChatRedirectPage {
  private readonly chats = inject(ChatsService);
  private readonly router = inject(Router);

  readonly id = input.required<string>();
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      void this.go(Number(this.id()));
    });
  }

  private async go(id: number): Promise<void> {
    if (!Number.isInteger(id) || id < 1) {
      this.error.set('Chat no encontrado.');
      return;
    }
    try {
      const chat = await this.chats.get(id);
      await this.router.navigate(['/projects', chat.projectId, 'chats', chat.id], {
        replaceUrl: true,
      });
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    }
  }
}
