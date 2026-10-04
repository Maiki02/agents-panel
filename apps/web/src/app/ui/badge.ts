import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';

const BASE = 'inline-block rounded-pill border px-2 py-px text-xs font-medium whitespace-nowrap';

const TONES: Record<BadgeTone, string> = {
  neutral: 'border-border text-muted',
  accent: 'border-accent text-accent',
  ok: 'border-ok text-ok',
  warn: 'border-warn text-warn',
  danger: 'border-danger text-danger',
};

export function badgeClasses(tone: BadgeTone): string {
  return `${BASE} ${TONES[tone]}`;
}

/** Status pill: `<app-badge tone="ok">Listo</app-badge>`. */
@Component({
  selector: 'app-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class]': 'classes()' },
  template: '<ng-content />',
})
export class Badge {
  readonly tone = input<BadgeTone>('neutral');
  protected readonly classes = computed(() => badgeClasses(this.tone()));
}
