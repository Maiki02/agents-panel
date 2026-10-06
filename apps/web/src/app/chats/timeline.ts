import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { WorktreeTransition } from '@agents-panel/shared';
import { Badge } from '../ui/badge';
import { formatRelative, formatTime, timelineEntries } from './timeline-logic';

/** Transitions of a work, newest first: who moved it, with which model and why it stopped. */
@Component({
  selector: 'app-timeline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Badge],
  template: `
    <ol class="m-0 flex list-none flex-col gap-2 p-0" aria-label="Timeline del trabajo">
      @for (entry of entries(); track entry.id) {
        <li class="rounded-card border border-border bg-surface px-3 py-2 text-sm">
          <div class="flex flex-wrap items-center gap-2">
            @if (entry.from) {
              <span class="text-muted">{{ entry.from }} →</span>
            }
            <app-badge [tone]="entry.tone">{{ entry.to }}</app-badge>
            <span class="ml-auto text-xs text-muted" [title]="time(entry.at)">{{
              ago(entry.at)
            }}</span>
          </div>
          <p class="m-0 mt-1 text-xs text-muted">
            {{ entry.actor }}
            @if (entry.session) {
              · {{ entry.session }}
            }
          </p>
          @if (entry.reason) {
            <p class="m-0 mt-1 break-words">{{ entry.reason }}</p>
          }
          @if (entry.decision) {
            <p class="m-0 mt-1 break-words text-muted">Decisión: {{ entry.decision }}</p>
          }
          @if (entry.debt.length > 0) {
            <ul class="m-0 mt-1 list-disc pl-5 text-muted">
              @for (line of entry.debt; track line) {
                <li>Deuda: {{ line }}</li>
              }
            </ul>
          }
        </li>
      } @empty {
        <li class="text-sm text-muted">
          Todavía no hay movimientos. Aparecen acá apenas el trabajo cambie de estado.
        </li>
      }
    </ol>
  `,
})
export class Timeline {
  readonly transitions = input.required<readonly WorktreeTransition[]>();

  protected readonly entries = computed(() => timelineEntries(this.transitions()));
  protected ago(epochMs: number): string {
    return formatRelative(epochMs, Date.now());
  }
  protected time(epochMs: number): string {
    return formatTime(epochMs);
  }
}
