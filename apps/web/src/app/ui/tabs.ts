import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { moveTab, resolveTab, type TabItem } from './tabs-logic';

export type { TabItem };

/**
 * Tab strip only: the page decides what to show for the active id (so the active tab can live
 * in the URL). `<app-tabs [tabs]="tabs" [active]="tab()" (selected)="go($event)" />`.
 */
@Component({
  selector: 'app-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div role="tablist" class="flex gap-1 border-b border-border">
      @for (tab of tabs(); track tab.id) {
        <button
          type="button"
          role="tab"
          class="-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors"
          [class]="
            tab.id === current()
              ? 'border-accent text-text'
              : 'border-transparent text-muted hover:text-text'
          "
          [attr.aria-selected]="tab.id === current()"
          [attr.tabindex]="tab.id === current() ? 0 : -1"
          [attr.data-tab]="tab.id"
          (click)="selected.emit(tab.id)"
          (keydown)="onKey($event)"
        >
          {{ tab.label }}
        </button>
      }
    </div>
  `,
})
export class Tabs {
  readonly tabs = input.required<readonly TabItem[]>();
  readonly active = input<string | null>(null);
  readonly selected = output<string>();

  protected readonly current = computed(() =>
    resolveTab(
      this.tabs().map((t) => t.id),
      this.active(),
    ),
  );

  protected onKey(event: KeyboardEvent): void {
    const next = moveTab(
      this.tabs().map((t) => t.id),
      this.current(),
      event.key,
    );
    if (next === null) return;
    event.preventDefault();
    this.selected.emit(next);
  }
}
