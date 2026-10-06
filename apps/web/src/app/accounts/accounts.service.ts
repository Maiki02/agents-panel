import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import type { ClaudeAccount, NewClaudeAccount } from '@agents-panel/shared';
import { firstValueFrom } from 'rxjs';

/**
 * Claude accounts of the panel, shared by the header selector and the Cuentas page. The active one
 * is global: the next turn of any chat runs with it.
 */
@Injectable({ providedIn: 'root' })
export class AccountsService {
  private readonly http = inject(HttpClient);

  readonly accounts = signal<ClaudeAccount[]>([]);
  readonly active = computed(() => this.accounts().find((account) => account.active) ?? null);

  async refresh(): Promise<void> {
    this.accounts.set(await firstValueFrom(this.http.get<ClaudeAccount[]>('/api/accounts')));
  }

  async activate(id: number): Promise<void> {
    await firstValueFrom(this.http.put<ClaudeAccount>('/api/accounts/active', { id }));
    await this.refresh();
  }

  async create(account: NewClaudeAccount): Promise<void> {
    await firstValueFrom(this.http.post<ClaudeAccount>('/api/accounts', account));
    await this.refresh();
  }

  async rename(id: number, name: string): Promise<void> {
    await firstValueFrom(this.http.patch<ClaudeAccount>(`/api/accounts/${String(id)}`, { name }));
    await this.refresh();
  }

  async remove(id: number): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/accounts/${String(id)}`));
    await this.refresh();
  }
}
