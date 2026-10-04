import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService, type LoginError } from './auth.service';

type Step = 'password' | 'code';

@Component({
  selector: 'app-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card narrow">
      <h1>Ingresar</h1>
      @if (step() === 'password') {
        <form (submit)="onPassword($event)">
          <label for="username">Usuario</label>
          <input
            id="username"
            name="username"
            autocomplete="username"
            required
            [value]="username()"
            (input)="username.set(value($event))"
          />
          <label for="password">Contraseña</label>
          <input
            id="password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
            [value]="password()"
            (input)="password.set(value($event))"
          />
          <button type="submit" [disabled]="busy() || !username() || !password()">Continuar</button>
        </form>
      } @else {
        <form (submit)="onCode($event)">
          <p>Ingresá el código de tu app de autenticación, o un código de recuperación.</p>
          <label for="code">Código</label>
          <input
            id="code"
            name="code"
            autocomplete="one-time-code"
            inputmode="text"
            required
            [value]="code()"
            (input)="code.set(value($event))"
          />
          <button type="submit" [disabled]="busy() || !code()">Entrar</button>
          <button type="button" class="link" (click)="back()">Volver</button>
        </form>
      }
      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
      <p class="hint">Tras 5 intentos fallidos seguidos la cuenta se bloquea 15 minutos.</p>
    </section>
  `,
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly step = signal<Step>('password');
  protected readonly username = signal('');
  protected readonly password = signal('');
  protected readonly code = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async onPassword(event: Event): Promise<void> {
    event.preventDefault();
    await this.run(async () => {
      await this.auth.submitPassword(this.username().trim(), this.password());
      this.password.set('');
      this.step.set('code');
    }, 'Usuario o contraseña incorrectos, o cuenta bloqueada.');
  }

  protected async onCode(event: Event): Promise<void> {
    event.preventDefault();
    await this.run(async () => {
      await this.auth.submitCode(this.code().trim());
      await this.router.navigateByUrl('/');
    }, 'Código incorrecto o vencido. Si sigue fallando, volvé y reingresá la contraseña.');
  }

  protected back(): void {
    this.code.set('');
    this.error.set(null);
    this.step.set('password');
  }

  private async run(action: () => Promise<void>, invalidMessage: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await action();
    } catch (cause) {
      const failure = (cause as LoginError).failure;
      this.error.set(
        failure === 'rate_limited'
          ? 'Demasiados intentos. Esperá un minuto y probá de nuevo.'
          : failure === 'invalid'
            ? invalidMessage
            : 'No se pudo conectar con el servidor.',
      );
    } finally {
      this.busy.set(false);
    }
  }
}
