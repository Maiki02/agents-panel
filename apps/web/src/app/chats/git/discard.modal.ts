import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { RepoStatus } from '@agents-panel/shared';
import { ConfirmModal } from '../../ui/confirm-modal';
import { apiErrorMessage } from '../chats.service';
import { discardQuestion, fileStatusLabel, repoTitle } from './git-logic';
import { GitService } from './git.service';

/**
 * Discard the uncommitted changes of chosen files. Nothing starts selected; the danger confirmation
 * names every selected file, and a refusal of the API (400) shows in the dialog.
 */
@Component({
  selector: 'app-discard-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConfirmModal],
  template: `
    <app-confirm-modal
      [heading]="'Descartar cambios en ' + title()"
      [confirmLabel]="'Descartar ' + selected().size"
      [busy]="busy()"
      [confirmDisabled]="selected().size === 0"
      [error]="error()"
      (confirmed)="discard()"
      (closed)="closed.emit()"
    >
      <fieldset class="m-0 max-h-48 overflow-y-auto border-0 p-0">
        <legend class="mb-1 font-medium">Archivos</legend>
        @for (file of repo().files; track file.path) {
          <label class="flex items-start gap-2 py-px">
            <input
              type="checkbox"
              class="mt-1"
              [checked]="selected().has(file.path)"
              (change)="toggle(file.path)"
            />
            <span class="w-20 shrink-0 text-xs text-muted">{{ statusLabel(file.status) }}</span>
            <span class="break-all">{{ file.path }}</span>
          </label>
        }
      </fieldset>
      @if (selected().size > 0) {
        <div class="rounded-control border border-danger p-2" role="status">
          <p class="m-0 font-medium text-danger">{{ question() }}</p>
          <ul class="m-0 mt-1 list-disc pl-5 text-xs">
            @for (file of chosen(); track file) {
              <li class="break-all">{{ file }}</li>
            }
          </ul>
        </div>
      }
    </app-confirm-modal>
  `,
})
export class DiscardModal {
  private readonly git = inject(GitService);

  readonly chatId = input.required<number>();
  readonly repo = input.required<RepoStatus>();
  /** The discard went through: the tab reloads the status. */
  readonly discarded = output();
  readonly closed = output();

  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly title = computed(() => repoTitle(this.repo().path));
  protected readonly chosen = computed(() =>
    this.repo()
      .files.map((file) => file.path)
      .filter((path) => this.selected().has(path)),
  );
  protected readonly question = computed(() => discardQuestion(this.chosen()));
  protected readonly statusLabel = fileStatusLabel;

  protected toggle(path: string): void {
    this.selected.update((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  protected async discard(): Promise<void> {
    if (this.busy() || this.chosen().length === 0) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const result = await this.git.discard(this.chatId(), this.repo().path, this.chosen());
      const failed = result.repos.find((r) => r.result === 'error');
      if (failed) {
        this.error.set(failed.output);
        return;
      }
      this.discarded.emit();
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.busy.set(false);
    }
  }
}
