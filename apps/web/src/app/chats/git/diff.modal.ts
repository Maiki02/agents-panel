import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import type { DiffAgainst, DiffFile, RepoDiff } from '@agents-panel/shared';
import { Button } from '../../ui/button';
import { Modal } from '../../ui/modal';
import { apiErrorMessage } from '../chats.service';
import { diffFileLabel, diffFileSummary, patchLineClass, repoTitle } from './git-logic';
import { GitService } from './git.service';

/** Read-only diff of a repo: the uncommitted changes or the work against its base (D27). */
@Component({
  selector: 'app-diff-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Button, Modal],
  template: `
    <app-modal [heading]="'Cambios en ' + title()" [wide]="true" (closed)="closed.emit()">
      <div class="mb-3 flex flex-wrap gap-2" role="group" aria-label="Comparar contra">
        <button
          appButton
          [variant]="against() === 'worktree' ? 'primary' : 'secondary'"
          type="button"
          [attr.aria-pressed]="against() === 'worktree'"
          (click)="load('worktree')"
        >
          Sin commitear
        </button>
        <button
          appButton
          [variant]="against() === 'base' ? 'primary' : 'secondary'"
          type="button"
          [attr.aria-pressed]="against() === 'base'"
          (click)="load('base')"
        >
          Contra la base{{ baseLabel() }}
        </button>
      </div>
      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
      @if (loading()) {
        <p class="hint">Leyendo los cambios…</p>
      } @else if (diff(); as d) {
        @if (d.files.length === 0) {
          <p class="hint">No hay cambios para mostrar.</p>
        }
        @for (file of d.files; track file.path) {
          <section class="mb-3 rounded-control border border-border">
            <div class="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1 text-sm">
              <span class="break-all font-medium">{{ file.path }}</span>
              <span class="text-xs text-muted">{{ label(file) }} · {{ summary(file) }}</span>
            </div>
            @if (file.binary) {
              <p class="m-0 px-2 py-1 text-xs text-muted">
                Archivo binario: no se muestra el parche.
              </p>
            } @else {
              <div class="max-h-80 overflow-auto px-2 py-1 font-mono text-xs">
                @for (line of lines(file); track $index) {
                  <div class="whitespace-pre" [class]="lineClass(line)">{{ line }}</div>
                }
              </div>
              @if (file.truncated) {
                <div class="border-t border-border px-2 py-1">
                  <button
                    appButton
                    variant="secondary"
                    type="button"
                    [disabled]="loadingFile() === file.path"
                    (click)="more(file)"
                  >
                    {{ loadingFile() === file.path ? 'Trayendo…' : 'Ver más' }}
                  </button>
                  <span class="ml-2 text-xs text-muted">El parche está recortado.</span>
                </div>
              }
            }
          </section>
        }
        @if (d.moreFiles) {
          <p class="hint">Cambiaron más archivos de los que se listan.</p>
        }
      }
    </app-modal>
  `,
})
export class DiffModal {
  private readonly git = inject(GitService);

  readonly chatId = input.required<number>();
  readonly repo = input.required<string>();
  readonly initial = input<DiffAgainst>('worktree');
  readonly closed = output();

  protected readonly against = signal<DiffAgainst>('worktree');
  protected readonly diff = signal<RepoDiff | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadingFile = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  protected readonly title = () => repoTitle(this.repo());
  protected readonly baseLabel = () => {
    const base = this.diff()?.baseBranch;
    return base ? ` (${base})` : '';
  };
  protected readonly label = diffFileLabel;
  protected readonly summary = diffFileSummary;
  protected readonly lineClass = patchLineClass;

  constructor() {
    effect(() => {
      const initial = this.initial();
      untracked(() => {
        void this.load(initial);
      });
    });
  }

  protected lines(file: DiffFile): string[] {
    return file.patch.split('\n');
  }

  protected async load(against: DiffAgainst): Promise<void> {
    this.against.set(against);
    this.loading.set(true);
    this.error.set(null);
    try {
      const diff = await this.git.diff(this.chatId(), this.repo(), against);
      if (this.against() === against) this.diff.set(diff);
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.loading.set(false);
    }
  }

  /** Asks for the file alone: the API cuts every patch of a full diff, but a single file comes whole. */
  protected async more(file: DiffFile): Promise<void> {
    this.loadingFile.set(file.path);
    this.error.set(null);
    try {
      const single = await this.git.diff(this.chatId(), this.repo(), this.against(), file.path);
      const full = single.files.find((f) => f.path === file.path);
      if (full) {
        this.diff.update((d) =>
          d ? { ...d, files: d.files.map((f) => (f.path === file.path ? full : f)) } : d,
        );
      }
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.loadingFile.set(null);
    }
  }
}
