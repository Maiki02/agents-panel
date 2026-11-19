import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { ChatUsage } from '@agents-panel/shared';
import { formatCost, formatTokens, usageRows } from './usage-logic';

/** Tokens and estimated cost of every session of a work, and the total. */
@Component({
  selector: 'app-usage',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section aria-label="Uso del trabajo" class="flex flex-col gap-2 text-sm">
      <div class="rounded-card border border-border bg-surface px-3 py-2" data-testid="usage-total">
        <strong>Total del trabajo</strong>
        <p class="m-0 mt-1 break-words text-muted">
          {{ tokens(usage().total.inputTokens) }} entrada ·
          {{ tokens(usage().total.outputTokens) }} salida ·
          {{ tokens(usage().total.cacheReadTokens) }} caché leída ·
          {{ tokens(usage().total.cacheCreationTokens) }} caché escrita ·
          <strong>{{ cost(usage().total.costUsd) }}</strong>
        </p>
      </div>
      <ol class="m-0 flex list-none flex-col gap-2 p-0">
        @for (row of rows(); track row.id) {
          <li class="rounded-card border border-border bg-surface px-3 py-2">
            <div class="flex flex-wrap items-center gap-2">
              <strong>{{ row.step }}</strong>
              @if (row.session) {
                <span class="text-xs text-muted">{{ row.session }}</span>
              }
            </div>
            @if (row.usage; as u) {
              <p class="m-0 mt-1 break-words text-muted">
                {{ tokens(u.inputTokens) }} entrada · {{ tokens(u.outputTokens) }} salida ·
                {{ tokens(u.cacheReadTokens) }} caché leída ·
                {{ tokens(u.cacheCreationTokens) }} caché escrita · {{ cost(u.costUsd) }}
              </p>
            } @else {
              <p class="m-0 mt-1 text-muted">Sin medición (terminó sin resultado).</p>
            }
          </li>
        } @empty {
          <li class="text-muted">Todavía no hay sesiones.</li>
        }
      </ol>
    </section>
  `,
})
export class UsagePanel {
  readonly usage = input.required<ChatUsage>();

  protected readonly rows = computed(() => usageRows(this.usage().sessions));
  protected tokens = formatTokens;
  protected cost = formatCost;
}
