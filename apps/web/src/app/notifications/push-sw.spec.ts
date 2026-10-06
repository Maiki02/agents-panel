import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const ORIGIN = 'https://panel.test';
const SOURCE = readFileSync(
  join(import.meta.dirname, '..', '..', '..', 'public', 'push-sw.js'),
  'utf8',
);

interface FakeClient {
  url: string;
  focused: boolean;
  navigatedTo: string | null;
  focus(): Promise<void>;
  navigate(url: string): Promise<void>;
}

function client(url: string): FakeClient {
  const fake: FakeClient = {
    url,
    focused: false,
    navigatedTo: null,
    focus: () => {
      fake.focused = true;
      return Promise.resolve();
    },
    navigate: (target) => {
      fake.navigatedTo = target;
      return Promise.resolve();
    },
  };
  return fake;
}

/** Runs the real push-sw.js in a context that fakes the service worker scope. */
function load(windows: FakeClient[] = []) {
  const handlers = new Map<string, (event: unknown) => void>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      handlers.set(type, handler);
    },
    skipWaiting: () => Promise.resolve(),
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve(windows),
      openWindow: (url: string) => {
        opened.push(url);
        return Promise.resolve(null);
      },
    },
    registration: {
      showNotification: (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
  };
  runInNewContext(SOURCE, { self, URL, JSON });

  const waits: Promise<unknown>[] = [];
  const dispatch = (type: string, event: Record<string, unknown>) => {
    handlers.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    return Promise.all(waits);
  };
  const push = (payload: unknown) =>
    dispatch('push', {
      data: { json: () => payload, text: () => String(payload) },
    });
  const click = (data: unknown) => {
    const notification = {
      closed: false,
      data,
      close() {
        this.closed = true;
      },
    };
    return dispatch('notificationclick', { notification }).then(() => notification);
  };
  return { handlers, shown, opened, push, click, dispatch };
}

describe('push-sw.js: push', () => {
  it('shows the notification with title, body, tag and the panel url', async () => {
    const sw = load();
    await sw.push({ title: 'Listo', body: 'Terminó el sprint', tag: 'chat-4', url: '/chats/4' });
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0]?.title).toBe('Listo');
    expect(sw.shown[0]?.options).toMatchObject({
      body: 'Terminó el sprint',
      tag: 'chat-4',
      renotify: true,
      data: { url: '/chats/4' },
    });
  });

  it('has defaults, shows a plain-text push as the body and drops an external url', async () => {
    const sw = load();
    await sw.push({ url: 'https://otro.com/x' });
    expect(sw.shown[0]?.title).toBe('Panel de agentes');
    expect(sw.shown[0]?.options).toMatchObject({ body: '', data: { url: '/' } });
    expect(sw.shown[0]?.options).not.toHaveProperty('tag');
    const text = load();
    await text.dispatch('push', {
      data: {
        json: () => {
          throw new Error('not json');
        },
        text: () => 'hola',
      },
    });
    expect(text.shown[0]?.options).toMatchObject({ body: 'hola' });
  });
});

describe('push-sw.js: notificationclick', () => {
  it('opens a new window on an internal route and closes the notification', async () => {
    const sw = load();
    const notification = await sw.click({ url: '/chats/9' });
    expect(notification.closed).toBe(true);
    expect(sw.opened).toEqual([`${ORIGIN}/chats/9`]);
  });

  it('focuses the open tab of the panel and takes it to the route instead of opening another', async () => {
    const tab = client(`${ORIGIN}/projects`);
    const sw = load([client('https://otro.com/'), tab]);
    await sw.click({ url: '/chats/9' });
    expect(tab.focused).toBe(true);
    expect(tab.navigatedTo).toBe(`${ORIGIN}/chats/9`);
    expect(sw.opened).toEqual([]);
  });

  it.each([
    'https://otro.com',
    'http://otro.com/x',
    '//otro.com/x',
    '/\\otro.com',
    '/\\\\otro.com',
    'javascript:alert(1)',
    'chats/9',
    '/chats/9\n//otro.com',
    42,
    null,
  ])('never opens %j outside the panel: it goes to the home', async (url) => {
    const sw = load();
    await sw.click({ url });
    expect(sw.opened).toEqual([`${ORIGIN}/`]);
    const withTab = client(`${ORIGIN}/x`);
    const tabbed = load([withTab]);
    await tabbed.click({ url });
    expect(withTab.navigatedTo).toBe(`${ORIGIN}/`);
  });

  it('opens the home when the notification carries no data', async () => {
    const sw = load();
    await sw.click(undefined);
    expect(sw.opened).toEqual([`${ORIGIN}/`]);
  });
});

describe('push-sw.js: lifecycle', () => {
  it('registers the four handlers and claims the clients on activate', async () => {
    const sw = load();
    expect([...sw.handlers.keys()].sort()).toEqual([
      'activate',
      'install',
      'notificationclick',
      'push',
    ]);
    await sw.dispatch('activate', {});
  });
});
