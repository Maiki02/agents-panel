import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { AccountSelector } from './accounts/account-selector';
import { AuthService } from './auth/auth.service';
import { currentUrl } from './shell/current-url';
import { APP_TITLE, activeNavPath, headerTitle } from './shell/nav-logic';
import { PageTitleStore } from './shell/page-title.store';
import { SideNav } from './shell/side-nav';
import { Button } from './ui/button';
import { Drawer } from './ui/drawer';
import { closesOnNavigation } from './ui/drawer-logic';
import { Icon } from './ui/icon';

/**
 * The shell fills the screen (100dvh): a fixed-height header (menu button, centered title and,
 * on wide screens, the Claude account) and `main` with the rest. The side menu is a drawer.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, Button, AccountSelector, SideNav, Drawer, Icon],
  host: { class: 'flex h-dvh flex-col' },
  template: `
    @if (auth.username(); as name) {
      <header
        class="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-border bg-surface px-2 md:px-3"
      >
        <div class="flex items-center">
          <button
            type="button"
            class="inline-flex size-10 items-center justify-center rounded-control text-text transition-colors hover:bg-surface-raised"
            aria-label="Abrir el menú"
            [attr.aria-expanded]="menuOpen()"
            (click)="menuOpen.set(true)"
          >
            <app-icon name="menu" />
          </button>
        </div>
        <p
          class="m-0 max-w-[55vw] truncate text-center font-semibold text-text"
          data-testid="title"
        >
          {{ title() }}
        </p>
        <div class="flex min-w-0 items-center justify-end">
          <div class="hidden lg:block">
            <app-account-selector />
          </div>
        </div>
      </header>
      <app-drawer [open]="menuOpen()" [heading]="appTitle" (closed)="menuOpen.set(false)">
        <app-side-nav [active]="active()" (navigated)="menuOpen.set(false)" />
        <div drawerFooter class="flex shrink-0 flex-col gap-3 border-t border-border p-3">
          <div class="lg:hidden">
            <app-account-selector />
          </div>
          <div class="flex items-center justify-between gap-2">
            <span class="min-w-0 truncate text-sm text-muted">{{ name }}</span>
            <button appButton variant="secondary" type="button" (click)="logout()">
              <app-icon name="logout" />
              Salir
            </button>
          </div>
        </div>
      </app-drawer>
    }
    <main class="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <router-outlet />
    </main>
  `,
})
export class App {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly pageTitle = inject(PageTitleStore);
  private readonly url = currentUrl();

  protected readonly appTitle = APP_TITLE;
  protected readonly menuOpen = signal(false);
  protected readonly active = computed(() => activeNavPath(this.url()));
  protected readonly title = computed(() => headerTitle(this.url(), this.pageTitle.projectName()));

  constructor() {
    // Any change of screen closes the menu (a link inside it, a redirect, the back button).
    let previous = this.url();
    effect(() => {
      const next = this.url();
      if (closesOnNavigation(previous, next)) this.menuOpen.set(false);
      previous = next;
    });
  }

  protected async logout(): Promise<void> {
    this.menuOpen.set(false);
    await this.auth.logout();
    await this.router.navigateByUrl('/login');
  }
}
