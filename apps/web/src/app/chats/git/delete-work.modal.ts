import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import type { DeletePreview } from '@agents-panel/shared';
import { ConfirmModal } from '../../ui/confirm-modal';
import { apiErrorMessage } from '../chats.service';
import { deleteRisks, repoTitle } from './git-logic';
import { GitService } from './git.service';

/**
 * Delete the work (D28): shows what would be lost per repo (unpushed commits, uncommitted files),
 * asks for a danger confirmation and, optionally, to delete the remote branches too. The work
 * stays in the list as an archived, read-only chat.
 */
@Component({
  selector: 'app-delete-work-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConfirmModal],
  template: `
    <app-confirm-modal
      heading="Borrar el trabajo"
      confirmLabel="Borrar trabajo"
      [busy]="busy()"
      [confirmDisabled]="loading() || preview() === null"
      [error]="error()"
      (confirmed)="remove()"
      (closed)="closed.emit()"
    >
      @if (loading()) {
        <p class="m-0 text-muted">Leyendo qué se perdería…</p>
      } @else if (preview(); as p) {
        <p class="m-0">
          Se borra el worktree y las ramas locales del trabajo. El chat queda archivado, en solo
          lectura.
        </p>
        @for (repo of p.repos; track repo.path) {
          <section class="rounded-control border border-border p-2">
            <strong>{{ name(repo.path) }}</strong>
            <span class="text-xs text-muted">
              {{ repo.branch ? ' · ' + repo.branch : ' · en su base: no hay rama para borrar' }}
            </span>
            @if (risks(repo); as list) {
              @if (list.length > 0) {
                <ul class="m-0 mt-1 list-disc pl-5 text-warn">
                  @for (risk of list; track risk) {
                    <li>{{ risk }}</li>
                  }
                </ul>
                @if (repo.uncommittedFiles.length > 0) {
                  <details class="mt-1 text-xs">
                    <summary>Archivos sin commitear</summary>
                    <ul class="m-0 list-disc pl-5">
                      @for (file of repo.uncommittedFiles; track file) {
                        <li class="break-all">{{ file }}</li>
                      }
                    </ul>
                  </details>
                }
              } @else {
                <p class="m-0 mt-1 text-xs text-muted">Nada en riesgo: todo está pusheado.</p>
              }
            }
          </section>
        }
        @if (hasUnpushed()) {
          <p class="m-0 font-medium text-danger" role="alert">
            Hay commits sin pushear: al borrar se pierden.
          </p>
        }
        <label class="flex items-start gap-2">
          <input
            type="checkbox"
            class="mt-1"
            [checked]="deleteRemote()"
            (change)="deleteRemote.set(!deleteRemote())"
          />
          <span>Borrar también las ramas del trabajo en el remoto (nunca la base)</span>
        </label>
      }
    </app-confirm-modal>
  `,
})
export class DeleteWorkModal {
  private readonly git = inject(GitService);

  readonly chatId = input.required<number>();
  readonly deleted = output();
  readonly closed = output();

  protected readonly preview = signal<DeletePreview | null>(null);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly deleteRemote = signal(false);

  protected readonly name = repoTitle;
  protected readonly risks = deleteRisks;

  constructor() {
    void this.load();
  }

  protected hasUnpushed(): boolean {
    return (this.preview()?.repos ?? []).some((repo) => repo.unpushedCommits > 0);
  }

  private async load(): Promise<void> {
    try {
      this.preview.set(await this.git.deletePreview(this.chatId()));
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.loading.set(false);
    }
  }

  protected async remove(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.git.deleteWork(this.chatId(), this.deleteRemote());
      this.deleted.emit();
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.busy.set(false);
    }
  }
}
