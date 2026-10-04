import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface SessionInfo {
  user: { id: number; username: string };
  csrfToken: string;
}

export type LoginFailure = 'invalid' | 'rate_limited' | 'network';

export class LoginError extends Error {
  constructor(readonly failure: LoginFailure) {
    super(failure);
  }
}

function toLoginError(error: unknown): LoginError {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 429) return new LoginError('rate_limited');
    if (error.status === 401 || error.status === 400 || error.status === 403) {
      return new LoginError('invalid');
    }
  }
  return new LoginError('network');
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly state = signal<SessionInfo | null>(null);
  private loaded: Promise<void> | undefined;

  readonly session = this.state.asReadonly();
  readonly csrfToken = computed(() => this.state()?.csrfToken ?? null);
  readonly username = computed(() => this.state()?.user.username ?? null);

  /** Looks the session up once; later calls reuse the result. */
  ensureLoaded(): Promise<void> {
    this.loaded ??= this.refresh();
    return this.loaded;
  }

  private async refresh(): Promise<void> {
    try {
      this.state.set(await firstValueFrom(this.http.get<SessionInfo>('/api/auth/me')));
    } catch {
      this.state.set(null);
    }
  }

  /** Step 1. Resolves when the password was right and a second factor is now required. */
  async submitPassword(username: string, password: string): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/api/auth/login', { username, password }));
    } catch (error) {
      throw toLoginError(error);
    }
  }

  /** Step 2: a TOTP code or a recovery code. On success the session is stored. */
  async submitCode(code: string): Promise<void> {
    try {
      const session = await firstValueFrom(this.http.post<SessionInfo>('/api/auth/totp', { code }));
      this.state.set(session);
      this.loaded = Promise.resolve();
    } catch (error) {
      throw toLoginError(error);
    }
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/api/auth/logout', {}));
    } finally {
      this.state.set(null);
      this.loaded = Promise.resolve();
    }
  }

  /** Called when any API answer says the session is gone. */
  markLoggedOut(): void {
    this.state.set(null);
    this.loaded = Promise.resolve();
  }
}
