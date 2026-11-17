import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { apiErrorMessage } from '../chats/chats.service';
import { Button } from '../ui/button';
import { Modal } from '../ui/modal';
import { canAddAccount } from './accounts-logic';
import { AccountsService } from './accounts.service';

/**
 * "Nueva cuenta" modal: name plus the command. The panel creates ~/.claude-<slug> linked to the
 * global ~/.claude and the command claude-<slug>; the login comes after, with «Reloguear».
 */
@Component({
  selector: 'app-add-account-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal, Button],
  template: `
    <app-modal heading="Nueva cuenta" (closed)="closed.emit()">
      <p class="hint">
        El panel crea la carpeta <code>~/.claude-{{ slugPreview() }}</code
        >, la enlaza con la config global <code>~/.claude</code> (skills, permisos y sesiones) y
        deja el comando <code>claude-{{ slugPreview() }}</code> en la VM. Después, «Reloguear» para
        hacer el login.
      </p>
      <form (submit)="submit($event)">
        <label for="account-name">Nombre</label>
        <input
          id="account-name"
          name="account-name"
          autocomplete="off"
          placeholder="Trabajo"
          data-autofocus
          [value]="name()"
          (input)="name.set(text($event))"
        />
        <label for="account-slug">Comando (claude-…)</label>
        <input
          id="account-slug"
          name="account-slug"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="work"
          [value]="slug()"
          (input)="slug.set(text($event))"
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
export class AddAccountModal {
  private readonly service = inject(AccountsService);

  readonly closed = output();

  protected readonly name = signal('');
  protected readonly slug = signal('');
  protected readonly slugPreview = computed(() => this.slug().trim() || '<comando>');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly canSubmit = computed(() =>
    canAddAccount(this.busy(), this.name(), this.slug()),
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
      await this.service.create({ name: this.name().trim(), slug: this.slug().trim() });
      this.closed.emit();
    } catch (cause) {
      // Stay open with what was typed so it can be fixed.
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.busy.set(false);
    }
  }
}
