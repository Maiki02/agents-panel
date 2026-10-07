import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  NewPushSubscription,
  PushConfig,
  PushSubscriptionInfo,
  PushTestResult,
} from '@agents-panel/shared';
import { firstValueFrom } from 'rxjs';
import { SwrCache } from '../shared/swr-cache';

@Injectable({ providedIn: 'root' })
export class NotificationsService {
  private readonly http = inject(HttpClient);
  private readonly configCache = new SwrCache<PushConfig>();
  private readonly listCache = new SwrCache<PushSubscriptionInfo[]>();

  /** The last answers, to paint at once while config() and list() fetch the new ones. */
  cachedConfig(): PushConfig | undefined {
    return this.configCache.peek();
  }

  cachedList(): PushSubscriptionInfo[] | undefined {
    return this.listCache.peek();
  }

  config(): Promise<PushConfig> {
    return this.configCache.load(() =>
      firstValueFrom(this.http.get<PushConfig>('/api/push/config')),
    );
  }

  list(): Promise<PushSubscriptionInfo[]> {
    return this.listCache.load(() =>
      firstValueFrom(this.http.get<PushSubscriptionInfo[]>('/api/push/subscriptions')),
    );
  }

  /** Every action on a device drops the cached list. */
  private changed<T>(request: Promise<T>): Promise<T> {
    return request.finally(() => {
      this.listCache.invalidate();
    });
  }

  /** Idempotent by endpoint: subscribing again from the same browser updates its row. */
  subscribe(body: NewPushSubscription): Promise<PushSubscriptionInfo> {
    return this.changed(
      firstValueFrom(this.http.post<PushSubscriptionInfo>('/api/push/subscriptions', body)),
    );
  }

  rename(id: number, name: string): Promise<PushSubscriptionInfo> {
    return this.changed(
      firstValueFrom(
        this.http.patch<PushSubscriptionInfo>(`/api/push/subscriptions/${String(id)}`, { name }),
      ),
    );
  }

  remove(id: number): Promise<unknown> {
    return this.changed(firstValueFrom(this.http.delete(`/api/push/subscriptions/${String(id)}`)));
  }

  test(id: number): Promise<PushTestResult> {
    return this.changed(
      firstValueFrom(
        this.http.post<PushTestResult>(`/api/push/subscriptions/${String(id)}/test`, {}),
      ),
    );
  }
}
