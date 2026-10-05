import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import type { ProjectPermissions } from '@agents-panel/shared';
import { apiErrorMessage, isInvalidTotp } from '../chats/chats.service';
import { TotpModal } from '../shared/totp-modal';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  applySuggestion,
  commandProblem,
  hostProblem,
  permissionsChanged,
  remainingSuggestions,
  withItem,
  withoutItem,
} from './permissions-logic';
import { ProjectsService } from './projects.service';

/**
 * Configuración > Permisos: what the agent may run through Bash in this project. The base and the
 * fixed denied commands are read-only; extra commands and curl hosts are edited in a draft that is
 * only saved after confirming with a fresh TOTP code.
 */
@Component({
  selector: 'app-permissions-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Badge, Button, TotpModal],
  template: `
    @if (permissions(); as current) {
      <h3>Comandos de la base</h3>
      <p class="hint">
        Todos los proyectos pueden usarlos. No se pueden quitar. El agente también puede leer
        archivos del worktree y usar curl solo en modo restringido (ver abajo).
      </p>
      <div class="env-row">
        @for (name of current.base; track name) {
          <app-badge>{{ name }}</app-badge>
        }
      </div>

      <h3 class="pt-4">Comandos de este proyecto</h3>
      <p class="hint">
        Nombres simples de comandos que el agente puede correr además de la base, por ejemplo
        <code>uv</code> o <code>make</code>. Cambiar la lista pide tu código de la app.
      </p>
      <div class="env-row">
        @for (name of commands(); track name) {
          <app-badge tone="accent">{{ name }}</app-badge>
          <button
            appButton
            variant="secondary"
            type="button"
            [attr.aria-label]="'Quitar ' + name"
            (click)="removeCommand(name)"
          >
            Quitar
          </button>
        } @empty {
          <p class="hint">
            Sin comandos extra. Agregá uno abajo o tocá una sugerencia si el proyecto la tiene.
          </p>
        }
      </div>
      <form (submit)="addCommand($event)">
        <label for="perm-command">Agregar un comando</label>
        <input
          id="perm-command"
          name="perm-command"
          autocomplete="off"
          autocapitalize="off"
          placeholder="uv"
          [class.invalid]="commandText() !== '' && commandError() !== null"
          [value]="commandText()"
          (input)="commandText.set(valueOf($event))"
        />
        @if (commandText() !== '' && commandError(); as message) {
          <span class="error" role="alert">{{ message }}</span>
        }
        <button appButton variant="secondary" type="submit" [disabled]="commandError() !== null">
          Agregar comando
        </button>
      </form>

      @if (suggestions().length > 0) {
        <h4 class="pt-4">Sugerencias del repositorio</h4>
        <p class="hint">Salen de los archivos del proyecto. No se aplican solas.</p>
        @for (s of suggestions(); track s.file) {
          <div class="suggestion">
            <span
              >Hay un <code>{{ s.file }}</code
              >: {{ s.commands.join(', ') }}</span
            >
            <button appButton variant="secondary" type="button" (click)="applySuggestionOf(s)">
              Agregar
            </button>
          </div>
        }
      }

      <h3 class="pt-4">Hosts de curl</h3>
      <p class="hint">
        curl solo hace GET o HEAD (sin -L, -d, -F, -T, -X, -o ni archivos con @) a
        {{ current.curlBaseHosts.join(' y ') }} y a los hosts de esta lista. Sin https:// ni puerto.
      </p>
      <div class="env-row">
        @for (host of hosts(); track host) {
          <app-badge tone="accent">{{ host }}</app-badge>
          <button
            appButton
            variant="secondary"
            type="button"
            [attr.aria-label]="'Quitar ' + host"
            (click)="removeHost(host)"
          >
            Quitar
          </button>
        } @empty {
          <p class="hint">Sin hosts extra: curl solo llega a localhost.</p>
        }
      </div>
      <form (submit)="addHost($event)">
        <label for="perm-host">Agregar un host</label>
        <input
          id="perm-host"
          name="perm-host"
          autocomplete="off"
          autocapitalize="off"
          placeholder="api.ejemplo.com"
          [class.invalid]="hostText() !== '' && hostError() !== null"
          [value]="hostText()"
          (input)="hostText.set(valueOf($event))"
        />
        @if (hostText() !== '' && hostError(); as message) {
          <span class="error" role="alert">{{ message }}</span>
        }
        <button appButton variant="secondary" type="submit" [disabled]="hostError() !== null">
          Agregar host
        </button>
      </form>

      <h3 class="pt-4">Nunca se habilitan</h3>
      <p class="hint">
        Pueden cambiar lo que se paga en Oracle o sacar datos de la VM, así que ninguna
        configuración los habilita.
      </p>
      <div class="env-row">
        @for (name of current.fixedDenied; track name) {
          <app-badge tone="danger">{{ name }}</app-badge>
        }
      </div>

      <div class="pt-4">
        <button appButton type="button" [disabled]="!dirty() || busy()" (click)="asking.set(true)">
          Guardar cambios
        </button>
        @if (!dirty()) {
          <span class="hint"> Sin cambios para guardar.</span>
        }
      </div>
      @if (saved()) {
        <p class="hint" role="status">Permisos guardados. Se aplican desde el próximo turno.</p>
      }
    }
    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }
    @if (asking()) {
      <app-totp-modal
        heading="Guardar permisos"
        submitLabel="Guardar"
        [busy]="busy()"
        [error]="totpError()"
        (submitted)="save($event)"
        (closed)="closeModal()"
      />
    }
  `,
})
export class PermissionsSection {
  private readonly service = inject(ProjectsService);

  readonly projectId = input.required<number>();

  /** What the API has saved. */
  protected readonly permissions = signal<ProjectPermissions | null>(null);
  /** The editable lists; nothing is saved until the user confirms with a code. */
  protected readonly commands = signal<string[]>([]);
  protected readonly hosts = signal<string[]>([]);
  protected readonly commandText = signal('');
  protected readonly hostText = signal('');
  protected readonly asking = signal(false);
  protected readonly busy = signal(false);
  protected readonly saved = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly totpError = signal<string | null>(null);

  protected readonly suggestions = computed(() =>
    remainingSuggestions(this.permissions()?.suggestions ?? [], this.commands()),
  );
  protected readonly dirty = computed(() => {
    const current = this.permissions();
    return (
      current !== null &&
      permissionsChanged(current, { commands: this.commands(), hosts: this.hosts() })
    );
  });
  protected readonly commandError = computed(() => {
    const current = this.permissions();
    return current === null
      ? 'Cargando…'
      : commandProblem(this.commandText(), current, this.commands());
  });
  protected readonly hostError = computed(() => {
    const current = this.permissions();
    return current === null ? 'Cargando…' : hostProblem(this.hostText(), current, this.hosts());
  });

  constructor() {
    effect(() => {
      void this.load(this.projectId());
    });
  }

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected addCommand(event: Event): void {
    event.preventDefault();
    if (this.commandError() !== null) return;
    this.commands.update((list) => withItem(list, this.commandText().trim()));
    this.commandText.set('');
    this.saved.set(false);
  }

  protected removeCommand(name: string): void {
    this.commands.update((list) => withoutItem(list, name));
    this.saved.set(false);
  }

  protected addHost(event: Event): void {
    event.preventDefault();
    if (this.hostError() !== null) return;
    this.hosts.update((list) => withItem(list, this.hostText().trim().toLowerCase()));
    this.hostText.set('');
    this.saved.set(false);
  }

  protected removeHost(host: string): void {
    this.hosts.update((list) => withoutItem(list, host));
    this.saved.set(false);
  }

  protected applySuggestionOf(suggestion: { file: string; commands: string[] }): void {
    this.commands.update((list) => applySuggestion(list, suggestion));
    this.saved.set(false);
  }

  protected closeModal(): void {
    this.asking.set(false);
    this.totpError.set(null);
  }

  protected async save(totp: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.totpError.set(null);
    try {
      const result = await this.service.savePermissions(this.projectId(), {
        commands: this.commands(),
        hosts: this.hosts(),
        totp,
      });
      this.apply(result);
      this.asking.set(false);
      this.saved.set(true);
    } catch (cause) {
      if (isInvalidTotp(cause)) {
        // Nothing was saved: the draft stays and only the code is retyped.
        this.totpError.set(apiErrorMessage(cause));
      } else {
        this.error.set(apiErrorMessage(cause));
        this.asking.set(false);
      }
    } finally {
      this.busy.set(false);
    }
  }

  private apply(result: ProjectPermissions): void {
    this.permissions.set(result);
    this.commands.set([...result.commands]);
    this.hosts.set([...result.hosts]);
  }

  private async load(id: number): Promise<void> {
    try {
      this.apply(await this.service.permissions(id));
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    }
  }
}
