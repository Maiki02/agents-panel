import webpush from 'web-push';
import type { PushVapid } from '../config.js';

/** What a push service needs to reach one browser. */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** `statusCode` is the push service's HTTP answer when it refused; null on a network failure. */
export type PushSendResult = { ok: true } | { ok: false; statusCode: number | null };

/** Sends one message. Tests inject a fake: nothing here touches the network. */
export interface PushSender {
  send(target: PushTarget, payload: string): Promise<PushSendResult>;
}

/** Web Push over HTTPS to the browsers' own push services (no extra infrastructure, US$0). */
export function createWebPushSender(vapid: PushVapid): PushSender {
  return {
    async send(target, payload) {
      try {
        await webpush.sendNotification(
          { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
          payload,
          {
            vapidDetails: {
              subject: vapid.subject,
              publicKey: vapid.publicKey,
              privateKey: vapid.privateKey,
            },
            TTL: 60 * 60,
            // A notice that the work needs the user must not wait for Android's Doze to end.
            urgency: 'high',
          },
        );
        return { ok: true };
      } catch (error) {
        const code = (error as { statusCode?: unknown }).statusCode;
        return { ok: false, statusCode: typeof code === 'number' ? code : null };
      }
    },
  };
}
