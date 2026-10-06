import type { PushTestResult } from '@agents-panel/shared';
import type { PushSender } from './sender.js';
import type { PushSubscriptionRepository, StoredPushSubscription } from './repo.js';

/** What the browser's service worker shows. */
export interface PushPayload {
  title: string;
  body: string;
  /** Path inside the panel the notification opens (for instance `/chats/12`). */
  url?: string;
  /** A newer notification with the same tag replaces the previous one (one per chat). */
  tag?: string;
}

/**
 * Sends notifications through the injected sender. Without a sender (no VAPID keys) it is off:
 * nothing is sent and `enabled` is false. A 404 or 410 from the push service means the browser
 * unsubscribed, so the row is deleted.
 */
export class PushService {
  constructor(
    private readonly subscriptions: PushSubscriptionRepository,
    private readonly sender: PushSender | null,
    readonly publicKey: string | null,
  ) {}

  get enabled(): boolean {
    return this.sender !== null && this.publicKey !== null;
  }

  async sendTo(
    subscription: StoredPushSubscription,
    payload: PushPayload,
  ): Promise<PushTestResult> {
    if (this.sender === null) return { sent: false, removed: false, statusCode: null };
    const result = await this.sender.send(subscription, JSON.stringify(payload));
    if (result.ok) {
      this.subscriptions.markSuccess(subscription.id);
      return { sent: true, removed: false, statusCode: null };
    }
    const gone = result.statusCode === 404 || result.statusCode === 410;
    if (gone) this.subscriptions.remove(subscription.id);
    return { sent: false, removed: gone, statusCode: result.statusCode };
  }

  /** To every subscription of every user (or of one user); failures never throw. */
  async broadcast(payload: PushPayload, userId?: number): Promise<void> {
    if (!this.enabled) return;
    const targets =
      userId === undefined ? this.subscriptions.listAll() : this.subscriptions.listForUser(userId);
    await Promise.all(targets.map((target) => this.sendTo(target, payload)));
  }
}
