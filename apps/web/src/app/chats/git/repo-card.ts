import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { RepoOpOutcome, RepoStatus } from '@agents-panel/shared';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { fileStatusLabel, outcomeLabel, outcomeTone, repoSummary, repoTitle } from './git-logic';

export type RepoAction = 'commit' | 'pull-base' | 'pull-branch' | 'push';

/** The last operation run on a repo and what it answered. */
export interface RepoResult {
  action: RepoAction;
  outcome: RepoOpOutcome;
}

const ACTION_LABELS: Record<RepoAction, string> = {
  commit: 'Commit',
  'pull-base': 'Traer base',
  'pull-branch': 'Traer mi rama',
  push: 'Push',
};

/** One repo of the work: branch, base, changed files, ahead/behind, its actions and last result. */
@Component({
  selector: 'app-repo-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Badge, Button],
  template: `
    <section
      class="rounded-card border border-border bg-surface p-3"
      [attr.aria-label]="'Repo ' + title()"
    >
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="m-0 text-base font-semibold">{{ title() }}</h3>
        <span class="break-all text-sm text-muted">
          {{ repo().branch }} → base {{ repo().baseBranch }}
        </span>
      </div>
      @if (repo().error; as problem) {
        <p class="error mt-2 mb-0" role="alert">{{ problem }}</p>
      } @else {
        <p class="mt-1 mb-2 text-sm text-muted">{{ summary() }}</p>
        @if (repo().files.length > 0) {
          <ul class="m-0 mb-2 max-h-40 list-none overflow-y-auto p-0 text-xs">
            @for (file of repo().files; track file.path) {
              <li class="flex gap-2 py-px">
                <span class="w-20 shrink-0 text-muted">{{ fileLabel(file.status) }}</span>
                <span class="break-all">{{ file.path }}</span>
              </li>
            }
          </ul>
        }
      }
      <div class="flex flex-wrap gap-2">
        <button appButton variant="secondary" type="button" (click)="act.emit('diff')">
          Ver cambios
        </button>
        <button
          appButton
          variant="secondary"
          type="button"
          [disabled]="disabled() || repo().files.length === 0"
          [title]="
            blockedReason() ?? (repo().files.length === 0 ? 'No hay cambios para descartar' : '')
          "
          (click)="act.emit('discard')"
        >
          Descartar
        </button>
        <button
          appButton
          variant="secondary"
          type="button"
          [disabled]="disabled() || repo().files.length === 0"
          [title]="
            blockedReason() ?? (repo().files.length === 0 ? 'No hay cambios para commitear' : '')
          "
          (click)="act.emit('commit')"
        >
          Commit
        </button>
        <button
          appButton
          variant="secondary"
          type="button"
          [disabled]="disabled()"
          [title]="blockedReason() ?? ''"
          (click)="act.emit('pull-base')"
        >
          Traer base
        </button>
        <button
          appButton
          variant="secondary"
          type="button"
          [disabled]="disabled()"
          [title]="blockedReason() ?? ''"
          (click)="act.emit('pull-branch')"
        >
          Traer mi rama
        </button>
        <button
          appButton
          variant="secondary"
          type="button"
          [disabled]="disabled()"
          [title]="blockedReason() ?? ''"
          (click)="act.emit('push')"
        >
          Push
        </button>
      </div>
      @if (busyAction(); as running) {
        <p class="mt-2 mb-0 text-sm text-muted" role="status">{{ label(running) }}…</p>
      }
      @if (result(); as r) {
        <div class="mt-2 rounded-control border border-border p-2" role="status">
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <app-badge [tone]="tone(r.outcome)">{{ outcome(r.outcome) }}</app-badge>
            <span>{{ label(r.action) }}</span>
          </div>
          @if (r.outcome.output) {
            <pre class="mt-2 mb-0 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{{
              r.outcome.output
            }}</pre>
          }
          @if (r.outcome.result === 'conflict' && r.outcome.conflicts?.length) {
            <p class="mt-2 mb-1 text-sm text-warn">El pull se abortó. Archivos en conflicto:</p>
            <ul class="m-0 mb-2 list-disc pl-5 text-xs">
              @for (file of r.outcome.conflicts; track file) {
                <li class="break-all">{{ file }}</li>
              }
            </ul>
            @if (r.outcome.askAgent) {
              <button
                appButton
                type="button"
                [disabled]="disabled()"
                [title]="blockedReason() ?? ''"
                (click)="askAgent.emit(r)"
              >
                Pedírselo al agente
              </button>
            }
          }
        </div>
      }
    </section>
  `,
})
export class RepoCard {
  readonly repo = input.required<RepoStatus>();
  /** Why the buttons are disabled (agent running, pilot busy, archived); null when they work. */
  readonly blockedReason = input<string | null>(null);
  /** The action running on this repo, if any: the buttons stay disabled until it ends. */
  readonly busyAction = input<RepoAction | null>(null);
  /** Another operation of the work is running: the server allows one at a time. */
  readonly workBusy = input(false);
  readonly result = input<RepoResult | null>(null);

  readonly act = output<RepoAction | 'diff' | 'discard'>();
  readonly askAgent = output<RepoResult>();

  protected readonly title = computed(() => repoTitle(this.repo().path));
  protected readonly summary = computed(() => repoSummary(this.repo()));
  protected readonly disabled = computed(() => this.blockedReason() !== null || this.workBusy());
  protected readonly fileLabel = fileStatusLabel;
  protected readonly tone = outcomeTone;
  protected readonly outcome = outcomeLabel;
  protected readonly label = (action: RepoAction): string => ACTION_LABELS[action];
}
