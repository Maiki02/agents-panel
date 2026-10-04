import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import type { EnvApplyResult, EnvFileInfo } from '@agents-panel/shared';
import { apiErrorMessage, isInvalidTotp } from '../chats/chats.service';
import { TotpModal } from '../shared/totp-modal';
import { EnvFilesService } from './env-files.service';
import {
  EMPTY_ENV_DRAFT,
  EnvSendError,
  envPathProblem,
  envSizeProblem,
  trySend,
  type EnvDraft,
} from './env-upload';
import { Button } from '../ui/button';

/** Write-only .env management: upload, replace and delete; the content never comes back (L3). */
@Component({
  selector: 'app-env-files-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, TotpModal, Button],
  template: `
    <h3>Archivos .env</h3>
    <p class="hint">
      Solo de desarrollo, nunca de producción. Se guardan cifrados y no se pueden ver ni editar acá:
      para cambiar uno, subilo de nuevo.
    </p>
    @for (file of files(); track file.path) {
      <div class="env-row">
        <code>{{ file.path }}</code>
        @if (file.readable) {
          <span class="hint"
            >{{ file.keyNames.join(', ') }} · {{ file.updatedAt | date: 'short' }}</span
          >
        } @else {
          <span class="error">Ilegible (cambió la clave del panel): volvé a subirlo.</span>
        }
        <button appButton variant="secondary" type="button" (click)="startReplace(file.path)">
          Reemplazar
        </button>
        <button appButton variant="danger" type="button" (click)="askDelete(file.path)">
          Borrar
        </button>
      </div>
    } @empty {
      <p class="hint">Todavía no hay archivos .env.</p>
    }

    @if (deleting(); as path) {
      <app-totp-modal
        [heading]="'Borrar ' + path"
        submitLabel="Borrar"
        [busy]="busy()"
        [error]="totpError()"
        (submitted)="confirmDelete($event)"
        (closed)="closeModals()"
      />
    }

    <form class="card" (submit)="askUpload($event)">
      <h4>Subir o reemplazar</h4>
      <label for="env-path">Ruta dentro del proyecto</label>
      <input
        id="env-path"
        name="env-path"
        autocomplete="off"
        placeholder="backend/.env"
        [class.invalid]="pathProblem() !== null"
        [value]="draft().path"
        (input)="setPath($event)"
      />
      @if (pathProblem(); as message) {
        <span class="error" role="alert">{{ message }}</span>
      }
      <label for="env-file">Archivo</label>
      <input id="env-file" name="env-file" type="file" (change)="readFile($event)" />
      <label for="env-text">…o pegá el texto</label>
      <textarea
        id="env-text"
        name="env-text"
        rows="5"
        autocomplete="off"
        spellcheck="false"
        [value]="draft().content"
        (input)="setContent($event)"
      ></textarea>
      @if (sizeProblem(); as message) {
        <span class="error" role="alert">{{ message }}</span>
      }
      <label class="check">
        <input type="checkbox" [checked]="draft().applyToActive" (change)="setApply($event)" />
        Aplicar también a los worktrees activos
      </label>
      @if (!asking()) {
        <button appButton type="submit" [disabled]="!canAsk()">Subir</button>
      }
    </form>

    @if (asking()) {
      <app-totp-modal
        heading="Subir .env"
        submitLabel="Subir .env"
        [busy]="busy()"
        [error]="totpError()"
        (submitted)="upload($event)"
        (closed)="closeModals()"
      />
    }

    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }
    @if (applied(); as results) {
      <table class="applied">
        <caption>
          Resultado por worktree
        </caption>
        @for (r of results; track r.chatId) {
          <tr>
            <td>Chat {{ r.chatId }}</td>
            <td>{{ r.status === 'written' ? 'Escrito' : 'Omitido' }}</td>
            <td>{{ r.reason ?? '' }}</td>
          </tr>
        }
      </table>
    }
  `,
})
export class EnvFilesSection {
  private readonly service = inject(EnvFilesService);

  readonly projectId = input.required<number>();

  protected readonly files = signal<EnvFileInfo[]>([]);
  /** Holds the pasted/loaded text only until it is sent (or the page is left). */
  protected readonly draft = signal<EnvDraft>(EMPTY_ENV_DRAFT);
  protected readonly asking = signal(false);
  protected readonly deleting = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Shown inside the open code modal (a wrong code leaves it open for a retry). */
  protected readonly totpError = signal<string | null>(null);
  protected readonly applied = signal<EnvApplyResult[] | null>(null);

  protected readonly pathProblem = computed(() =>
    this.draft().path.trim() === '' ? null : envPathProblem(this.draft().path),
  );
  protected readonly sizeProblem = computed(() => envSizeProblem(this.draft().content));
  protected readonly canAsk = computed(
    () =>
      envPathProblem(this.draft().path) === null &&
      this.draft().content.trim() !== '' &&
      this.sizeProblem() === null,
  );

  constructor() {
    effect(() => {
      void this.load(this.projectId());
    });
  }

  protected setPath(event: Event): void {
    const path = (event.target as HTMLInputElement).value;
    this.draft.update((d) => ({ ...d, path }));
  }

  protected setContent(event: Event): void {
    const content = (event.target as HTMLTextAreaElement).value;
    this.draft.update((d) => ({ ...d, content }));
  }

  protected setApply(event: Event): void {
    const applyToActive = (event.target as HTMLInputElement).checked;
    this.draft.update((d) => ({ ...d, applyToActive }));
  }

  protected async readFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const content = await file.text();
    input.value = '';
    this.draft.update((d) => ({ ...d, content }));
  }

  protected startReplace(path: string): void {
    this.draft.update((d) => ({ ...d, path }));
  }

  protected askUpload(event: Event): void {
    event.preventDefault();
    if (!this.canAsk()) return;
    this.totpError.set(null);
    this.asking.set(true);
  }

  protected askDelete(path: string): void {
    this.error.set(null);
    this.totpError.set(null);
    this.deleting.set(path);
  }

  protected closeModals(): void {
    this.asking.set(false);
    this.deleting.set(null);
    this.totpError.set(null);
  }

  protected async upload(totp: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.totpError.set(null);
    this.applied.set(null);
    const id = this.projectId();
    const before = this.draft();
    try {
      const { draft, result } = await trySend(before, (d) =>
        this.service.put(id, {
          path: d.path.trim(),
          content: d.content,
          totp,
          ...(d.applyToActive ? { applyToActive: true } : {}),
        }),
      );
      this.draft.set({ ...draft, path: '', applyToActive: false });
      this.applied.set(result.applied ?? null);
      this.asking.set(false);
      await this.load(id);
    } catch (cause) {
      const reason = cause instanceof EnvSendError ? cause.reason : cause;
      if (isInvalidTotp(reason)) {
        // Nothing was saved: keep the draft and the modal so only the code is retyped.
        this.draft.set(before);
        this.totpError.set(apiErrorMessage(reason));
      } else {
        // Any other failure drops the content too: to retry, paste it again.
        this.draft.set(cause instanceof EnvSendError ? cause.draft : { ...before, content: '' });
        this.error.set(apiErrorMessage(reason));
        this.asking.set(false);
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected async confirmDelete(totp: string): Promise<void> {
    const path = this.deleting();
    if (path === null) return;
    this.busy.set(true);
    this.error.set(null);
    this.totpError.set(null);
    try {
      await this.service.remove(this.projectId(), path, totp);
      this.deleting.set(null);
      await this.load(this.projectId());
    } catch (cause) {
      if (isInvalidTotp(cause)) {
        this.totpError.set(apiErrorMessage(cause));
      } else {
        this.error.set(apiErrorMessage(cause));
        this.deleting.set(null);
      }
    } finally {
      this.busy.set(false);
    }
  }

  private async load(id: number): Promise<void> {
    try {
      this.files.set(await this.service.list(id));
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    }
  }
}
