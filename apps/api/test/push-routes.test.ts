import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PushConfig, PushSubscriptionInfo, PushTestResult } from '@agents-panel/shared';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { isPushServiceEndpoint } from '../src/push/routes.js';
import { PushSubscriptionRepository } from '../src/push/repo.js';
import type { PushSendResult, PushSender, PushTarget } from '../src/push/sender.js';
import { PushService } from '../src/push/service.js';
import { PASSWORD, TEST_ENV, makeApp, mutatingHeaders } from './helpers.js';

const VAPID = {
  PUSH_VAPID_PUBLIC_KEY: 'fake-public-key',
  PUSH_VAPID_PRIVATE_KEY: 'fake-private-key',
  PUSH_VAPID_SUBJECT: 'mailto:test@example.com',
};

class FakeSender implements PushSender {
  readonly sent: { target: PushTarget; payload: string }[] = [];
  next: PushSendResult = { ok: true };
  send(target: PushTarget, payload: string): Promise<PushSendResult> {
    this.sent.push({ target, payload });
    return Promise.resolve(this.next);
  }
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(overrides: Record<string, string> = VAPID) {
  const sender = new FakeSender();
  const made = makeApp(overrides, undefined, { pushSender: sender });
  app = made.app;
  await made.app.ready();
  const users = new UserRepository(made.db);
  const login = async (name: string) => {
    const user = await users.create(name, PASSWORD);
    const { token, csrfToken } = new SessionService(made.db, {
      idleTtlSeconds: 1800,
      absoluteTtlSeconds: 43200,
    }).create(user.id);
    return mutatingHeaders(`${SESSION_COOKIE}=${token}`, csrfToken);
  };
  const alice = await login('alice');
  const bob = await login('bob');
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers: Record<string, string>,
    payload?: object,
  ) => made.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  const subscribe = (headers: Record<string, string>, endpoint: string, name?: string) =>
    call('POST', '/api/push/subscriptions', headers, {
      endpoint,
      keys: { p256dh: 'p256', auth: 'auth' },
      ...(name ? { name } : {}),
    });
  return { ...made, sender, alice, bob, call, subscribe };
}

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc';

describe('push config', () => {
  it('stays disabled without VAPID keys and boots anyway', async () => {
    const { call, alice, sender, subscribe } = await boot({});
    const config = (await call('GET', '/api/push/config', alice)).json<PushConfig>();
    expect(config).toEqual({ enabled: false, publicKey: null });
    const created = (await subscribe(alice, ENDPOINT)).json<PushSubscriptionInfo>();
    const test = await call('POST', `/api/push/subscriptions/${String(created.id)}/test`, alice);
    expect(test.statusCode).toBe(409);
    expect(sender.sent).toEqual([]);
  });

  it('exposes the public key and never the private one when enabled', async () => {
    const { call, alice } = await boot();
    const res = await call('GET', '/api/push/config', alice);
    expect(res.json<PushConfig>()).toEqual({ enabled: true, publicKey: 'fake-public-key' });
    expect(res.body).not.toContain('fake-private-key');
  });

  it('validates the variables of the environment', () => {
    expect(loadConfig(TEST_ENV).pushVapid).toBeNull();
    expect(loadConfig({ ...TEST_ENV, ...VAPID }).pushVapid).toMatchObject({
      publicKey: 'fake-public-key',
    });
    expect(() => loadConfig({ ...TEST_ENV, PUSH_VAPID_PUBLIC_KEY: 'x' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...TEST_ENV, ...VAPID, PUSH_VAPID_SUBJECT: 'x' })).toThrow(
      ConfigError,
    );
  });
});

describe('push subscriptions', () => {
  it('the same endpoint twice leaves a single row, updated', async () => {
    const { call, alice, subscribe } = await boot();
    const first = (await subscribe(alice, ENDPOINT, 'PC')).json<PushSubscriptionInfo>();
    const second = (await subscribe(alice, ENDPOINT, 'PC nueva')).json<PushSubscriptionInfo>();
    expect(second.id).toBe(first.id);
    const list = (await call('GET', '/api/push/subscriptions', alice)).json<
      PushSubscriptionInfo[]
    >();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('PC nueva');
    expect(JSON.stringify(list)).not.toContain('p256');
  });

  it('caps a user at 10 devices: the 11th gets 409 with the reason, re-subscribing stays idempotent', async () => {
    const { call, alice, bob, subscribe } = await boot();
    const endpoint = (n: number) => `https://fcm.googleapis.com/fcm/send/device-${String(n)}`;
    for (let n = 1; n <= 10; n++)
      expect((await subscribe(alice, endpoint(n))).statusCode).toBe(200);
    const eleventh = await subscribe(alice, endpoint(11));
    expect(eleventh.statusCode).toBe(409);
    expect(eleventh.json<{ error: string }>().error).toContain('quitá un dispositivo');
    // The same endpoint again is an update, not a new device.
    expect((await subscribe(alice, endpoint(3), 'Renombrada')).statusCode).toBe(200);
    const list = (await call('GET', '/api/push/subscriptions', alice)).json<
      PushSubscriptionInfo[]
    >();
    expect(list).toHaveLength(10);
    expect(list.find((item) => item.endpoint === endpoint(3))?.name).toBe('Renombrada');
    // The cap is per user, and removing one frees a place.
    expect((await subscribe(bob, endpoint(11))).statusCode).toBe(200);
    const first = list[0];
    expect(
      (await call('DELETE', `/api/push/subscriptions/${String(first?.id)}`, alice)).statusCode,
    ).toBe(204);
    expect((await subscribe(alice, endpoint(12))).statusCode).toBe(200);
  });

  it('refuses an endpoint that is not https or a body with unknown keys', async () => {
    const { call, alice, subscribe } = await boot();
    expect((await subscribe(alice, 'http://push.example.com/x')).statusCode).toBe(400);
    expect((await subscribe(alice, 'not a url')).statusCode).toBe(400);
    const extra = await call('POST', '/api/push/subscriptions', alice, {
      endpoint: ENDPOINT,
      keys: { p256dh: 'a', auth: 'b' },
      userId: 2,
    });
    expect(extra.statusCode).toBe(400);
  });

  it('renames, tests and removes only the subscriptions of the user', async () => {
    const { call, alice, bob, subscribe, sender } = await boot();
    const mine = (await subscribe(alice, ENDPOINT, 'PC')).json<PushSubscriptionInfo>();
    const url = `/api/push/subscriptions/${String(mine.id)}`;
    for (const [method, path] of [
      ['PATCH', url],
      ['POST', `${url}/test`],
      ['DELETE', url],
    ] as const) {
      const res = await call(method, path, bob, method === 'PATCH' ? { name: 'x' } : undefined);
      expect(res.statusCode).toBe(404);
    }
    expect((await call('GET', '/api/push/subscriptions', bob)).json<unknown[]>()).toEqual([]);
    expect(sender.sent).toEqual([]);

    const renamed = await call('PATCH', url, alice, { name: 'Android' });
    expect(renamed.json<PushSubscriptionInfo>().name).toBe('Android');
    const test = await call('POST', `${url}/test`, alice);
    expect(test.json<PushTestResult>()).toEqual({ sent: true, removed: false, statusCode: null });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.target.endpoint).toBe(ENDPOINT);
    expect(
      (await call('GET', '/api/push/subscriptions', alice)).json<PushSubscriptionInfo[]>()[0]
        ?.lastSuccessAt,
    ).not.toBeNull();
    expect((await call('DELETE', url, alice)).statusCode).toBe(204);
    expect((await call('GET', '/api/push/subscriptions', alice)).json<unknown[]>()).toEqual([]);
  });

  it.each([404, 410])('a test that gets %i deletes the subscription and says so', async (code) => {
    const { call, alice, subscribe, sender } = await boot();
    const mine = (await subscribe(alice, ENDPOINT)).json<PushSubscriptionInfo>();
    sender.next = { ok: false, statusCode: code };
    const res = await call('POST', `/api/push/subscriptions/${String(mine.id)}/test`, alice);
    expect(res.json<PushTestResult>()).toEqual({ sent: false, removed: true, statusCode: code });
    expect((await call('GET', '/api/push/subscriptions', alice)).json<unknown[]>()).toEqual([]);
  });

  it('keeps the subscription on other failures', async () => {
    const { call, alice, subscribe, sender } = await boot();
    const mine = (await subscribe(alice, ENDPOINT)).json<PushSubscriptionInfo>();
    sender.next = { ok: false, statusCode: 500 };
    const res = await call('POST', `/api/push/subscriptions/${String(mine.id)}/test`, alice);
    expect(res.json<PushTestResult>()).toEqual({ sent: false, removed: false, statusCode: 500 });
    expect((await call('GET', '/api/push/subscriptions', alice)).json<unknown[]>()).toHaveLength(1);
  });

  it('answers 401 without a session and 403 without CSRF', async () => {
    const { app: a, alice } = await boot();
    const origin = { origin: 'http://localhost:4200' };
    expect((await a.inject({ url: '/api/push/config', headers: origin })).statusCode).toBe(401);
    expect((await a.inject({ url: '/api/push/subscriptions', headers: origin })).statusCode).toBe(
      401,
    );
    const body = { endpoint: ENDPOINT, keys: { p256dh: 'a', auth: 'b' } };
    expect(
      (
        await a.inject({
          method: 'POST',
          url: '/api/push/subscriptions',
          headers: origin,
          payload: body,
        })
      ).statusCode,
    ).toBe(401);
    const noCsrf = { cookie: alice['cookie'] ?? '', ...origin };
    expect(
      (
        await a.inject({
          method: 'POST',
          url: '/api/push/subscriptions',
          headers: noCsrf,
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('PushService', () => {
  it('does not send when it has no sender', async () => {
    const { db } = await boot();
    const repo = new PushSubscriptionRepository(db);
    const service = new PushService(repo, null, null);
    expect(service.enabled).toBe(false);
    await expect(service.broadcast({ title: 't', body: 'b' })).resolves.toBeUndefined();
  });

  it('broadcast reaches every subscription and drops the gone ones', async () => {
    const { db, sender } = await boot();
    const repo = new PushSubscriptionRepository(db);
    const user = new UserRepository(db).findByUsername('alice');
    const base = { p256dh: 'a', auth: 'b', name: 'n', userAgent: null };
    repo.upsert(user?.id ?? 0, { ...base, endpoint: 'https://p.example.com/1' });
    repo.upsert(user?.id ?? 0, { ...base, endpoint: 'https://p.example.com/2' });
    const service = new PushService(repo, sender, 'k');
    sender.next = { ok: false, statusCode: 410 };
    await service.broadcast({ title: 't', body: 'b' });
    expect(sender.sent).toHaveLength(2);
    expect(repo.listAll()).toEqual([]);
  });
});

describe('push endpoint host', () => {
  it('accepts the endpoints of the browsers push services', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
      'https://web.push.apple.com/abc',
      'https://api.sandbox.push.apple.com/3/device/abc',
      'https://FCM.googleapis.com:443/x',
    ]) {
      expect(isPushServiceEndpoint(ok), ok).toBe(true);
    }
  });

  it('refuses internal, foreign, look-alike and non-https hosts', () => {
    for (const bad of [
      'https://127.0.0.1/x',
      'https://localhost/x',
      'https://169.254.169.254/x',
      'https://push.example.com/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilfcm.googleapis.com.example/x',
      'https://notify.windows.com/x',
      'https://user:pass@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'http://fcm.googleapis.com/x',
      'not a url',
    ]) {
      expect(isPushServiceEndpoint(bad), bad).toBe(false);
    }
  });

  it('answers 400 and saves nothing for a host that is not a push service', async () => {
    const { call, alice, subscribe } = await boot();
    for (const bad of [
      'https://127.0.0.1/x',
      'https://push.example.com/x',
      'https://localhost/x',
    ]) {
      expect((await subscribe(alice, bad)).statusCode, bad).toBe(400);
    }
    expect((await call('GET', '/api/push/subscriptions', alice)).json<unknown[]>()).toEqual([]);
  });
});
