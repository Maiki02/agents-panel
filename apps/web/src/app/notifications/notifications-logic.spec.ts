import { describe, expect, it } from 'vitest';
import {
  pushSupport,
  subscriptionBody,
  suggestedName,
  testMessage,
  urlBase64ToBytes,
  type PushEnvironment,
} from './notifications-logic';

const ok: PushEnvironment = {
  serverEnabled: true,
  secureContext: true,
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  permission: 'default',
  isIos: false,
  isStandalone: false,
  subscribed: false,
};

describe('pushSupport', () => {
  it('is ready when everything is available, and the button has no reason', () => {
    expect(pushSupport(ok)).toEqual({ kind: 'ready', reason: null });
    expect(pushSupport({ ...ok, permission: 'granted' }).kind).toBe('ready');
  });

  it.each([
    ['disabled', { serverEnabled: false }],
    ['insecure', { secureContext: false }],
    ['ios_install', { isIos: true }],
    ['unsupported', { hasPushManager: false }],
    ['unsupported', { hasServiceWorker: false }],
    ['unsupported', { hasNotification: false }],
    ['denied', { permission: 'denied' as const }],
    ['subscribed', { subscribed: true }],
  ])('says %s with a reason', (kind, change) => {
    const support = pushSupport({ ...ok, ...change });
    expect(support.kind).toBe(kind);
    expect(support.reason).not.toBeNull();
  });

  it('lets an iPhone through once the panel runs from the home screen', () => {
    expect(pushSupport({ ...ok, isIos: true, isStandalone: true }).kind).toBe('ready');
  });

  it('reports the disabled panel before anything the browser lacks', () => {
    expect(pushSupport({ ...ok, serverEnabled: false, hasPushManager: false }).kind).toBe(
      'disabled',
    );
  });
});

describe('suggestedName', () => {
  it('names the browser and the system', () => {
    expect(
      suggestedName(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
      ),
    ).toBe('Chrome en Windows');
    expect(
      suggestedName('Mozilla/5.0 (Windows NT 10.0) Chrome/126.0 Safari/537.36 Edg/126.0'),
    ).toBe('Edge en Windows');
    expect(
      suggestedName('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126.0 Mobile Safari/537.36'),
    ).toBe('Chrome en Android');
    expect(
      suggestedName(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Safari/605.1.15',
      ),
    ).toBe('Safari en iPhone');
    expect(
      suggestedName('Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0'),
    ).toBe('Firefox en Linux');
  });

  it('falls back to something readable', () => {
    expect(suggestedName('')).toBe('Este dispositivo');
    expect(suggestedName('curl/8.0')).toBe('Este dispositivo');
  });
});

describe('subscription helpers', () => {
  it('decodes a URL-safe base64 key', () => {
    expect([...urlBase64ToBytes('AQID')]).toEqual([1, 2, 3]);
    expect([...urlBase64ToBytes('-_8')]).toEqual([251, 255]);
  });

  it('builds the body only when the subscription has its keys', () => {
    expect(
      subscriptionBody({ endpoint: 'https://p/x', keys: { p256dh: 'a', auth: 'b' } }, 'PC'),
    ).toEqual({
      endpoint: 'https://p/x',
      keys: { p256dh: 'a', auth: 'b' },
      name: 'PC',
    });
    expect(subscriptionBody({ endpoint: 'https://p/x', keys: { p256dh: 'a' } }, 'PC')).toBeNull();
    expect(subscriptionBody({}, 'PC')).toBeNull();
  });

  it('explains the result of a test', () => {
    expect(testMessage({ sent: true, removed: false, statusCode: null })).toMatch(/enviado/);
    expect(testMessage({ sent: false, removed: true, statusCode: 410 })).toMatch(/se quitó/);
    expect(testMessage({ sent: false, removed: false, statusCode: 500 })).toContain('500');
    expect(testMessage({ sent: false, removed: false, statusCode: null })).not.toContain('null');
  });
});
