import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from './auth/auth.service';
import { Button } from './ui/button';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Button],
  template: `
    <header class="flex items-center gap-3 border-b border-border bg-surface px-4 py-2.5">
      <a routerLink="/" class="font-semibold text-text hover:no-underline">Panel de agentes</a>
      @if (auth.username()) {
        <nav class="flex gap-3 text-sm">
          <a
            routerLink="/"
            class="text-muted hover:text-text hover:no-underline"
            routerLinkActive="!text-text font-semibold"
            [routerLinkActiveOptions]="{ exact: true }"
          >
            Proyectos
          </a>
          <a
            routerLink="/versions"
            class="text-muted hover:text-text hover:no-underline"
            routerLinkActive="!text-text font-semibold"
          >
            Versiones
          </a>
        </nav>
      }
      @if (auth.username(); as name) {
        <span class="flex-1"></span>
        <span class="text-sm text-muted">{{ name }}</span>
        <button appButton variant="secondary" type="button" (click)="logout()">Salir</button>
      }
    </header>
    <main>
      <router-outlet />
    </main>
  `,
})
export class App {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected async logout(): Promise<void> {
    await this.auth.logout();
    await this.router.navigateByUrl('/login');
  }
}
