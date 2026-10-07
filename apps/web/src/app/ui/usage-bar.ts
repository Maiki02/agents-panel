import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { UsageTone } from '@agents-panel/shared';
import { toneClasses } from '../usage/usage-logic';

/** Horizontal progress bar colored by tone: `<app-usage-bar [percent]="42" tone="ok" />`. */
@Component({
  selector: 'app-usage-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block h-2 w-full overflow-hidden rounded-pill bg-surface-raised',
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    '[attr.aria-valuenow]': 'clamped()',
  },
  template: `<div
    class="h-full rounded-pill"
    [class]="fill()"
    [style.width.%]="clamped() ?? 0"
  ></div>`,
})
export class UsageBar {
  /** 0-100; null draws an empty bar. */
  readonly percent = input<number | null>(null);
  readonly tone = input<UsageTone | null>(null);

  protected readonly clamped = computed(() => {
    const value = this.percent();
    return value === null ? null : Math.min(100, Math.max(0, Math.round(value)));
  });
  protected readonly fill = computed(() => toneClasses(this.tone()).bar);
}
