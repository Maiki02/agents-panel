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

/** "Nueva cuenta" modal: name plus the absolute config dir of a login already made in the VM. */
@Component({
  selector: 'app-add-account-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal, Button],
  template: `
    <app-modal heading="Nueva cuenta" (closed)="closed.emit()">
      <p class="hint">
        Antes, en la VM: <code>CLAUDE_CONFIG_DIR=~/.claude2 claude</code> (y <code>/login</code>) y
        <code>bash scripts/vm/11-claude-cuentas.sh ~/.claude2</code> para compartir skills, permisos
        y sesiones con la principal.
      </p>
      <form (submit)="submit($event)">
        <label for="account-name">Nombre</label>
        <input
          id="account-name"
          name="account-name"
          autocomplete="off"
          placeholder="Miqueas - Bimtrazer"
          data-autofocus
          [value]="name()"
          (input)="name.set(text($event))"
        />
        <label for="account-dir">Directorio de config (ruta absoluta)</label>
        <input
          id="account-dir"
          name="account-dir"
          autocomplete="off"
          placeholder="/home/ubuntu/.claude2"
          [value]="dir()"
          (input)="dir.set(text($event))"
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
  protected readonly dir = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly canSubmit = computed(() =>
    canAddAccount(this.busy(), this.name(), this.dir()),
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
      await this.service.create({ name: this.name().trim(), configDir: this.dir().trim() });
      this.closed.emit();
    } catch (cause) {
      // Stay open with what was typed so it can be fixed.
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.busy.set(false);
    }
  }
}
