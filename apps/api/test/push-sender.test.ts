import webpush from 'web-push';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebPushSender } from '../src/push/sender.js';

vi.mock('web-push', () => ({ default: { sendNotification: vi.fn() } }));

const send = vi.mocked(webpush.sendNotification);
const vapid = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:a@b.c' };
const target = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'k1', auth: 'k2' };

afterEach(() => {
  send.mockReset();
});

describe('createWebPushSender', () => {
  it('sends the payload to the subscription with the VAPID identity, high urgency and a TTL', async () => {
    send.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    const result = await createWebPushSender(vapid).send(target, '{"title":"t"}');
    expect(result).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
    const [subscription, payload, options] = send.mock.calls[0] ?? [];
    expect(subscription).toEqual({
      endpoint: target.endpoint,
      keys: { p256dh: 'k1', auth: 'k2' },
    });
    expect(payload).toBe('{"title":"t"}');
    expect(options).toMatchObject({
      vapidDetails: { subject: vapid.subject, publicKey: 'pub', privateKey: 'priv' },
      urgency: 'high',
      TTL: 3600,
    });
  });

  it.each([404, 410])(
    'reports %i as the push service refusing it (the subscription expired)',
    async (statusCode) => {
      send.mockRejectedValue(Object.assign(new Error('gone'), { statusCode }));
      await expect(createWebPushSender(vapid).send(target, 'x')).resolves.toEqual({
        ok: false,
        statusCode,
      });
    },
  );

  it('reports a 500 with its code, so the caller keeps the subscription', async () => {
    send.mockRejectedValue(Object.assign(new Error('boom'), { statusCode: 500 }));
    await expect(createWebPushSender(vapid).send(target, 'x')).resolves.toEqual({
      ok: false,
      statusCode: 500,
    });
  });

  it('never throws: a network failure has no status code', async () => {
    send.mockRejectedValue(new Error('ECONNRESET'));
    await expect(createWebPushSender(vapid).send(target, 'x')).resolves.toEqual({
      ok: false,
      statusCode: null,
    });
    send.mockRejectedValue('not an error');
    await expect(createWebPushSender(vapid).send(target, 'x')).resolves.toEqual({
      ok: false,
      statusCode: null,
    });
  });
});
