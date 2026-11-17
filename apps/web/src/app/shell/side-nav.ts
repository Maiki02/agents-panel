import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from '../ui/icon';
import { EXTERNAL_NAV_ITEMS, NAV_ITEMS, externalHref } from './nav-logic';

/**
 * The options of the side menu, each with its Material icon. The active one gets a raised
 * background, white/dark text, semibold weight and a bar in the primary color on its left.
 */
@Component({
  selector: 'app-side-nav',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon],
  template: `
    <nav aria-label="Secciones del panel">
      <ul class="m-0 flex list-none flex-col gap-1 p-0">
        @for (item of items; track item.path; let first = $first) {
          <li>
            <a
              [routerLink]="item.path"
              [attr.aria-current]="item.path === active() ? 'page' : null"
              [attr.data-autofocus]="first ? '' : null"
              class="relative flex min-h-11 items-center gap-3 rounded-control px-3 py-2 text-sm transition-colors hover:no-underline"
              [class]="
                item.path === active()
                  ? 'bg-surface-raised font-semibold text-text before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-pill before:bg-accent'
                  : 'text-muted hover:bg-surface-raised hover:text-text'
              "
              (click)="navigated.emit()"
            >
              <app-icon [name]="item.icon" />
              <span>{{ item.label }}</span>
            </a>
          </li>
        }
        @for (item of externalItems; track item.port) {
          <li
            [class.mt-3]="$first"
            [class.border-t]="$first"
            [class.border-border]="$first"
            [class.pt-3]="$first"
          >
            <a
              [href]="hrefOf(item)"
              target="_blank"
              rel="noopener"
              class="flex min-h-11 items-center gap-3 rounded-control px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-raised hover:text-text hover:no-underline"
              (click)="navigated.emit()"
            >
              <app-icon [name]="item.icon" />
              <span>{{ item.label }}</span>
            </a>
          </li>
        }
      </ul>
    </nav>
  `,
})
export class SideNav {
  /** Path of the active option (see activeNavPath). */
  readonly active = input<string | null>(null);
  readonly navigated = output();

  protected readonly items = NAV_ITEMS;
  protected readonly externalItems = EXTERNAL_NAV_ITEMS;

  protected hrefOf(item: (typeof EXTERNAL_NAV_ITEMS)[number]): string {
    return externalHref(item, window.location);
  }
}
