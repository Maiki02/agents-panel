import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import type { ProviderUsage } from '@agents-panel/shared';
import { firstValueFrom } from 'rxjs';

/**
 * Usage of the active Claude account, shared by the header icon and its panel. The API caches the
 * on-demand reading for 60 s, so loading often is cheap; this never asks to skip that cache.
 */
@Injectable({ providedIn: 'root' })
export class UsageService {
  private readonly http = inject(HttpClient);

  readonly usage = signal<ProviderUsage | null>(null);
  readonly failed = signal(false);
  readonly loading = signal(false);
  readonly windows = computed(() => this.usage()?.windows ?? []);

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.usage.set(await firstValueFrom(this.http.get<ProviderUsage>('/api/usage')));
      this.failed.set(false);
    } catch {
      // Keeps the last data on screen; the panel says it could not refresh.
      this.failed.set(true);
    } finally {
      this.loading.set(false);
    }
  }
}
