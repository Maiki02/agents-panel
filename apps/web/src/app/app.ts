import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from './auth/auth.service';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header class="bar">
      <a routerLink="/" class="brand">agents-panel</a>
      @if (auth.username()) {
        <nav class="menu">
          <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">
            Proyectos
          </a>
          <a routerLink="/versions" routerLinkActive="active">Versiones</a>
        </nav>
      }
      @if (auth.username()) {
        <nav class="menu">
          <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">
            Proyectos
          </a>
          <a routerLink="/versions" routerLinkActive="active">Versiones</a>
        </nav>
      }
      @if (auth.username(); as name) {
        <span class="spacer"></span>
        <span class="who">{{ name }}</span>
        <button type="button" (click)="logout()">Salir</button>
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
