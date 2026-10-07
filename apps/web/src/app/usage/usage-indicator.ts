import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { AccountsService } from '../accounts/accounts.service';
import { Icon } from '../ui/icon';
import { UsageBar } from '../ui/usage-bar';
import {
  formatAgo,
  formatPercent,
  formatReset,
  headlinePercent,
  headlineTone,
  sortWindows,
  toneClasses,
  windowLabel,
  windowTone,
} from './usage-logic';
import { UsageService } from './usage.service';

/** How often the icon reloads while the tab is visible (the API serves its 60 s cache in between). */
const REFRESH_MS = 3 * 60 * 1000;

/**
 * Header icon with the 5 h usage of the active Claude account. A click opens a panel (popover on
 * desktop, bottom sheet on mobile) with every window: bar, percent, local reset time and age.
 */
@Component({
  selector: 'app-usage-indicator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, UsageBar],
  host: {
    class: 'relative inline-flex',
    '(document:keydown.escape)': 'close()',
    '(document:click)': 'onDocumentClick($event)',
  },
  template: `
    <button
      type="button"
      class="inline-flex h-9 items-center gap-1.5 rounded-control border border-border bg-surface px-2 text-sm transition-colors hover:bg-surface-raised"
      aria-label="Uso de la cuenta"
      aria-haspopup="dialog"
      [attr.aria-expanded]="open()"
      (click)="toggle()"
    >
      <app-icon name="gauge" [class]="headlineText()" />
      <span [class]="headlineText()">{{ headline() }}</span>
    </button>
    @if (open()) {
      <div
        role="dialog"
        aria-label="Uso de la cuenta"
        class="fixed inset-x-0 bottom-0 z-40 max-h-[80vh] overflow-y-auto rounded-t-card border border-border bg-surface p-4 shadow-modal sm:absolute sm:inset-x-auto sm:right-0 sm:bottom-auto sm:top-full sm:mt-2 sm:w-80 sm:rounded-card"
      >
        <div class="mb-3 flex items-center justify-between gap-2">
          <h2 class="m-0 text-base font-semibold">Uso de Claude</h2>
          <button
            type="button"
            class="inline-flex size-8 items-center justify-center rounded-control text-muted hover:bg-surface-raised hover:text-text sm:hidden"
            aria-label="Cerrar"
            (click)="close()"
          >
            <app-icon name="close" />
          </button>
        </div>
        @if (service.usage()?.degraded) {
          <p class="mb-3 text-xs text-warn" role="status">
            No se pudo leer el uso ahora; se muestra el último dato conocido.
          </p>
        } @else if (service.failed()) {
          <p class="mb-3 text-xs text-warn" role="status">
            No se pudo actualizar; se muestra el último dato.
          </p>
        }
        @if (rows().length === 0) {
          <p class="m-0 text-sm text-muted">
            @if (service.loading()) {
              Leyendo el uso…
            } @else {
              Todavía no hay datos de uso de esta cuenta.
            }
          </p>
        } @else {
          <ul class="m-0 flex list-none flex-col gap-3 p-0">
            @for (row of rows(); track row.window) {
              <li>
                <div class="mb-1 flex items-baseline justify-between gap-2 text-sm">
                  <span>{{ row.label }}</span>
                  <span [class]="row.text">{{ row.percent }}</span>
                </div>
                <app-usage-bar [percent]="row.value" [tone]="row.tone" />
                @if (row.reset) {
                  <p class="mt-1 mb-0 text-xs text-muted">Se reinicia {{ row.reset }}</p>
                }
              </li>
            }
          </ul>
          @if (ago(); as text) {
            <p class="mt-3 mb-0 text-xs text-muted">Actualizado {{ text }}</p>
          }
        }
      </div>
    }
  `,
})
export class UsageIndicator {
  protected readonly service = inject(UsageService);
  private readonly accounts = inject(AccountsService);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  private readonly activeId = computed(() => this.accounts.active()?.id);
  protected readonly open = signal(false);
  private readonly now = signal(Date.now());

  protected readonly headline = computed(() =>
    formatPercent(headlinePercent(this.service.windows())),
  );
  protected readonly headlineText = computed(
    () => toneClasses(headlineTone(this.service.windows())).text,
  );
  protected readonly rows = computed(() => {
    const now = this.now();
    return sortWindows(this.service.windows()).map((w) => {
      const tone = windowTone(w);
      return {
        window: w.window,
        label: windowLabel(w.window),
        value: w.utilization,
        percent: formatPercent(w.utilization),
        tone,
        text: toneClasses(tone).text,
        reset: w.resetsAt === null ? null : formatReset(w.resetsAt, now),
      };
    });
  });
  protected readonly ago = computed(() => {
    const observedAt = this.service.usage()?.observedAt ?? null;
    return observedAt === null ? null : formatAgo(observedAt, this.now());
  });

  constructor() {
    // Loads on start and again whenever the active account changes.
    effect(() => {
      // Depends on the active account id; the API answers for the active account.
      if (this.activeId() === undefined) {
        // No account yet: still load, the API decides.
      }
      untracked(() => {
        void this.reload();
      });
    });
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void this.reload();
    }, REFRESH_MS);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
    });
  }

  protected toggle(): void {
    const next = !this.open();
    this.open.set(next);
    if (next) void this.reload();
  }

  protected close(): void {
    this.open.set(false);
  }

  protected onDocumentClick(event: MouseEvent): void {
    if (this.open() && !this.element.nativeElement.contains(event.target as Node)) this.close();
  }

  private async reload(): Promise<void> {
    await this.service.load();
    this.now.set(Date.now());
  }
}
