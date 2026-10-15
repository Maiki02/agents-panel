import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import type { GitAccount, NewGitAccount } from '@agents-panel/shared';
import { firstValueFrom } from 'rxjs';

/**
 * GitHub and GitLab accounts of the panel. Tokens only go up (link, replace): the API never sends
 * them back, so nothing here can hold one.
 */
@Injectable({ providedIn: 'root' })
export class GitAccountsService {
  private readonly http = inject(HttpClient);

  readonly accounts = signal<GitAccount[]>([]);

  async refresh(): Promise<void> {
    this.accounts.set(await firstValueFrom(this.http.get<GitAccount[]>('/api/git-accounts')));
  }

  /** Needs a fresh TOTP code (inside the body). */
  async create(account: NewGitAccount): Promise<void> {
    await firstValueFrom(this.http.post<GitAccount>('/api/git-accounts', account));
    await this.refresh();
  }

  async rename(id: number, name: string): Promise<void> {
    await firstValueFrom(this.http.patch<GitAccount>(`/api/git-accounts/${String(id)}`, { name }));
    await this.refresh();
  }

  /** Replaces the token; needs a fresh TOTP code. */
  async replaceToken(id: number, token: string, totp: string): Promise<void> {
    await firstValueFrom(
      this.http.patch<GitAccount>(`/api/git-accounts/${String(id)}`, { token, totp }),
    );
    await this.refresh();
  }

  async remove(id: number): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/git-accounts/${String(id)}`));
    await this.refresh();
  }
}
