import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import type { MaintenanceKind, MaintenanceRun } from '@agents-panel/shared';
import { apiErrorMessage } from '../chats/chats.service';
import { Badge, type BadgeTone } from '../ui/badge';
import { runDate, runRange } from './version-label';
import { VersionsService } from './versions.service';

export const HISTORY_PAGE = 10;

const RUN_STATUS: Record<MaintenanceRun['status'], string> = {
  running: 'En curso',
  ok: 'Listo',
  error: 'Error',
};

/** Splits what the API answered (one more than asked for) into the rows shown and whether more exist. */
export function historyPage<T>(rows: T[], size: number): { shown: T[]; more: boolean } {
  return { shown: rows.slice(0, size), more: rows.length > size };
}

/**
 * A fresh first page on top of the rows already loaded: the older ones (ids below the page) stay,
 * so «Ver más» keeps its offset. Without older rows, `more` is the page's own.
 */
export function mergeTop<T extends { id: number }>(
  page: { shown: T[]; more: boolean },
  loaded: T[],
  loadedMore: boolean,
): { runs: T[]; more: boolean } {
  if (!page.more || page.shown.length === 0) return { runs: page.shown, more: page.more };
  const oldest = Math.min(...page.shown.map((run) => run.id));
  const tail = loaded.filter((run) => run.id < oldest);
  return { runs: [...page.shown, ...tail], more: tail.length > 0 ? loadedMore : page.more };
}

/**
 * «Ver historial» of a Versiones card: the runs of one kind, ten at a time with «Ver más». Closed
 * until asked; while open it reloads the pages it shows whenever `stamp` (the newest run of the
 * page's poll) changes, so a run that finishes updates its row.
 */
@Component({
  selector: 'app-run-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Badge],
  template: `
    <button
      type="button"
      class="text-action mt-1 text-sm"
      [attr.aria-expanded]="open()"
      (click)="toggle()"
    >
      {{ open() ? 'Ocultar historial' : 'Ver historial' }}
    </button>
    @if (open()) {
      <div class="mt-2 border-t border-border">
        @if (error(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }
        @for (run of runs(); track run.id) {
          <details class="run border-b border-border">
            <summary class="flex cursor-pointer list-none items-start justify-between gap-3 py-2">
              <span class="flex min-w-0 flex-col">
                <code class="truncate text-xs">{{ range(run) }}</code>
                <span class="text-xs text-muted">{{ date(run.startedAt) }}</span>
              </span>
              <app-badge [tone]="tone(run)">{{ status(run) }}</app-badge>
            </summary>
            <div class="pb-2 text-xs">
              @if (run.skipped.length > 0) {
                <p class="hint" role="status">
                  No se actualizó el workspace de
                  {{ run.skipped.length === 1 ? 'este proyecto' : 'estos proyectos' }}
                  porque tienen cambios locales fuera de .agents/kyro/:
                  @for (root of run.skipped; track root) {
                    <code class="block">{{ root }}</code>
                  }
                  Commiteá o descartá esos cambios y volvé a actualizar.
                </p>
              }
              @if (run.committed.length > 0) {
                <p class="hint" role="status">
                  Subido directo a la rama base:
                  @for (root of run.committed; track root) {
                    <code class="block">{{ root }}</code>
                  }
                </p>
              }
              @if (run.commitFailures.length > 0) {
                <p class="hint" role="status">
                  No se pudo subir a la rama base (se reintenta en la próxima actualización):
                  @for (failure of run.commitFailures; track failure.root) {
                    <span class="block"
                      ><code>{{ failure.root }}</code
                      >: {{ failure.reason }}</span
                    >
                  }
                </p>
              }
              @if (run.output) {
                <pre class="m-0">{{ run.output }}</pre>
              } @else {
                <p class="hint">Sin salida todavía.</p>
              }
            </div>
          </details>
        } @empty {
          @if (loaded()) {
            <p class="hint mt-2">Todavía no hay corridas.</p>
          } @else {
            <p class="hint mt-2" role="status">Cargando…</p>
          }
        }
        @if (more()) {
          <button
            type="button"
            class="text-action mt-2 text-sm"
            [disabled]="loading()"
            (click)="loadMore()"
          >
            Ver más
          </button>
        }
      </div>
    }
  `,
})
export class RunHistory {
  private readonly service = inject(VersionsService);

  readonly kind = input.required<MaintenanceKind>();
  /** Changes when the newest run of this kind changes (new run, or one that finished). */
  readonly stamp = input<string>('');

  protected readonly open = signal(false);
  protected readonly runs = signal<MaintenanceRun[]>([]);
  protected readonly more = signal(false);
  protected readonly loaded = signal(false);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      this.stamp();
      if (untracked(this.open)) void untracked(() => this.reload());
    });
  }

  protected range = runRange;
  protected date = runDate;

  protected status(run: MaintenanceRun): string {
    return RUN_STATUS[run.status];
  }

  protected tone(run: MaintenanceRun): BadgeTone {
    return run.status === 'ok' ? 'ok' : run.status === 'error' ? 'danger' : 'accent';
  }

  protected toggle(): void {
    const opening = !this.open();
    this.open.set(opening);
    if (opening) void this.reload();
  }

  /** Fresh first page; the older rows already loaded are kept (runs only change near the top). */
  private async reload(): Promise<void> {
    await this.fetch(0, (page) => mergeTop(page, this.runs(), this.more()));
  }

  protected async loadMore(): Promise<void> {
    await this.fetch(this.runs().length, (page) => ({
      runs: [...this.runs(), ...page.shown],
      more: page.more,
    }));
  }

  private async fetch(
    offset: number,
    merge: (page: { shown: MaintenanceRun[]; more: boolean }) => {
      runs: MaintenanceRun[];
      more: boolean;
    },
  ): Promise<void> {
    this.loading.set(true);
    try {
      const rows = await this.service.history(this.kind(), offset, HISTORY_PAGE + 1);
      const next = merge(historyPage(rows, HISTORY_PAGE));
      this.runs.set(next.runs);
      this.more.set(next.more);
      this.error.set(null);
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.loaded.set(true);
      this.loading.set(false);
    }
  }
}
