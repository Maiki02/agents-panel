import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type IconName = 'refresh' | 'close' | 'plus';

/** 24x24 stroke paths (Lucide-style); the stroke follows `currentColor`. */
export const ICON_PATHS: Record<IconName, string> = {
  refresh: 'M21 12a9 9 0 1 1-3-6.7M21 4v5h-5',
  close: 'M18 6 6 18M6 6l12 12',
  plus: 'M12 5v14M5 12h14',
};

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0', 'aria-hidden': 'true' },
  template: `
    <svg
      class="size-5"
      [class.animate-spin]="spin()"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path [attr.d]="path()" />
    </svg>
  `,
})
export class Icon {
  readonly name = input.required<IconName>();
  /** Rotates the icon (for example a refresh while an action is running). */
  readonly spin = input(false);

  protected path(): string {
    return ICON_PATHS[this.name()];
  }
}
