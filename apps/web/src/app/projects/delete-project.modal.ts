import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { DeleteBlocker } from '@agents-panel/shared';
import { isCompleteCode, sanitizeCode, takeCode } from '../shared/totp-code';
import { Button } from '../ui/button';
import { Modal } from '../ui/modal';
import { blockerLabel, nameMatches } from './repo-actions';

/**
 * Asks for the project's name and a fresh TOTP code before deleting it. The code is emitted once and
 * cleared right away, and also when the modal closes (never kept, like the other code prompts).
 */
@Component({
  selector: 'app-delete-project-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal, Button],
  template: `
    <app-modal heading="Borrar proyecto" (closed)="close()">
      <form (submit)="submit($event)">
        <p class="hint">
          Borra el clon de la VM, sus worktrees, los chats y los .env guardados. No toca GitHub. Si
          hay trabajo sin commitear o sin pushear, no se borra.
        </p>
        <label for="delete-name">Escribí el nombre del proyecto: {{ label() }}</label>
        <input
          id="delete-name"
          name="delete-name"
          autocomplete="off"
          data-autofocus
          [value]="typed()"
          (input)="typed.set(text($event))"
          [disabled]="busy()"
        />
        <label for="delete-code">Código de la app (6 dígitos)</label>
        <input
          id="delete-code"
          name="delete-code"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="6"
          [value]="code()"
          (input)="code.set(clean($event))"
          [disabled]="busy()"
        />
        @if (error(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }
        @if (blockers().length > 0) {
          <ul class="m-0 list-none p-0 text-sm" aria-label="Trabajo sin guardar">
            @for (item of blockers(); track item.path + item.detail) {
              <li class="py-1">
                <strong>{{ labelOf(item) }}</strong> en <code>{{ item.path }}</code
                >: {{ item.detail }}
              </li>
            }
          </ul>
        }
        <button appButton variant="danger" type="submit" [disabled]="busy() || !canSubmit()">
          {{ busy() ? 'Borrando…' : 'Borrar proyecto' }}
        </button>
      </form>
    </app-modal>
  `,
})
export class DeleteProjectModal {
  /** The name the project shows; the user must type it. */
  readonly label = input.required<string>();
  readonly busy = input(false);
  readonly error = input<string | null>(null);
  readonly blockers = input<DeleteBlocker[]>([]);
  readonly submitted = output<{ name: string; code: string }>();
  readonly closed = output();

  protected readonly typed = signal('');
  protected readonly code = signal('');
  protected readonly canSubmit = computed(
    () => nameMatches(this.label(), this.typed()) && isCompleteCode(this.code()),
  );

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected clean(event: Event): string {
    return sanitizeCode((event.target as HTMLInputElement).value);
  }

  protected labelOf(blocker: DeleteBlocker): string {
    return blockerLabel(blocker);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (!nameMatches(this.label(), this.typed())) return;
    const { send, remaining } = takeCode(this.code());
    this.code.set(remaining);
    if (send !== null) this.submitted.emit({ name: this.typed().trim(), code: send });
  }

  protected close(): void {
    this.code.set('');
    this.typed.set('');
    this.closed.emit();
  }
}
