import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { RepoStatus } from '@agents-panel/shared';
import { Button } from '../../ui/button';
import { Modal } from '../../ui/modal';
import { commitWarning, fileStatusLabel, repoTitle } from './git-logic';

export interface CommitChoice {
  files: string[];
  message: string;
}

/** Pick the files and write the message of a commit. A message that is not Conventional only warns. */
@Component({
  selector: 'app-commit-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Button, Modal],
  template: `
    <app-modal [heading]="'Commit en ' + title()" (closed)="closed.emit()">
      <form class="flex flex-col gap-3" (submit)="submit($event)">
        <fieldset class="m-0 max-h-56 overflow-y-auto border-0 p-0">
          <legend class="mb-1 text-sm font-medium">Archivos</legend>
          @for (file of repo().files; track file.path) {
            <label class="flex items-start gap-2 py-px text-sm">
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
        <label class="flex flex-col gap-1 text-sm font-medium">
          Mensaje
          <textarea
            data-autofocus
            rows="3"
            class="rounded-control border border-border bg-surface px-2 py-1 font-normal"
            [value]="message()"
            (input)="message.set(value($event))"
          ></textarea>
        </label>
        @if (warning(); as text) {
          <p class="m-0 text-sm text-warn" role="status">{{ text }}</p>
        }
        <div class="flex justify-end gap-2">
          <button appButton variant="secondary" type="button" (click)="showDiff.emit()">
            Ver cambios
          </button>
          <button appButton variant="secondary" type="button" (click)="closed.emit()">
            Cancelar
          </button>
          <button appButton type="submit" [disabled]="!canCommit()">
            Commitear {{ selected().size }}
          </button>
        </div>
      </form>
    </app-modal>
  `,
})
export class CommitModal {
  readonly repo = input.required<RepoStatus>();
  readonly confirmed = output<CommitChoice>();
  readonly closed = output();
  /** Look at the changes before writing the message. */
  readonly showDiff = output();

  protected readonly message = signal('');
  /** Everything starts selected; the user unchecks what does not belong in this commit. */
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly title = computed(() => repoTitle(this.repo().path));
  protected readonly warning = computed(() => commitWarning(this.message()));
  protected readonly canCommit = computed(
    () => this.selected().size > 0 && this.message().trim() !== '',
  );
  protected readonly statusLabel = fileStatusLabel;

  constructor() {
    queueMicrotask(() => {
      this.selected.set(new Set(this.repo().files.map((file) => file.path)));
    });
  }

  protected toggle(path: string): void {
    this.selected.update((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  protected value(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (!this.canCommit()) return;
    const files = this.repo()
      .files.map((file) => file.path)
      .filter((path) => this.selected().has(path));
    this.confirmed.emit({ files, message: this.message().trim() });
  }
}
