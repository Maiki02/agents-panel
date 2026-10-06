import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  NewPushSubscription,
  PushConfig,
  PushSubscriptionInfo,
  PushTestResult,
} from '@agents-panel/shared';
import { firstValueFrom } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class NotificationsService {
  private readonly http = inject(HttpClient);

  config(): Promise<PushConfig> {
    return firstValueFrom(this.http.get<PushConfig>('/api/push/config'));
  }

  list(): Promise<PushSubscriptionInfo[]> {
    return firstValueFrom(this.http.get<PushSubscriptionInfo[]>('/api/push/subscriptions'));
  }

  /** Idempotent by endpoint: subscribing again from the same browser updates its row. */
  subscribe(body: NewPushSubscription): Promise<PushSubscriptionInfo> {
    return firstValueFrom(this.http.post<PushSubscriptionInfo>('/api/push/subscriptions', body));
  }

  rename(id: number, name: string): Promise<PushSubscriptionInfo> {
    return firstValueFrom(
      this.http.patch<PushSubscriptionInfo>(`/api/push/subscriptions/${String(id)}`, { name }),
    );
  }

  remove(id: number): Promise<unknown> {
    return firstValueFrom(this.http.delete(`/api/push/subscriptions/${String(id)}`));
  }

  test(id: number): Promise<PushTestResult> {
    return firstValueFrom(
      this.http.post<PushTestResult>(`/api/push/subscriptions/${String(id)}/test`, {}),
    );
  }
}
