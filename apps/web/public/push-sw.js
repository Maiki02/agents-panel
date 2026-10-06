/* Service worker of the panel: it only shows Web Push notifications and opens the panel when one is
 * tapped. It caches nothing and never touches the API. */

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/** True for a backslash or a control character (code under 32): neither belongs in a panel path. */
function hasBackslashOrControl(value) {
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' || value.charCodeAt(i) < 32) return true;
  }
  return false;
}

/**
 * Only a path inside the panel is opened: anything else falls back to the home. A backslash is out
 * too: URL parsing reads `/\host` as `//host`, which would leave the panel.
 */
function panelPath(value) {
  return typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !hasBackslashOrControl(value)
    ? value
    : '/';
}

/** The JSON the panel sent; a plain-text push still shows as a body. */
function readPayload(event) {
  if (!event.data) return {};
  try {
    return event.data.json();
  } catch {
    return { body: event.data.text() };
  }
}

self.addEventListener('push', (event) => {
  const payload = readPayload(event);
  const title =
    typeof payload.title === 'string' && payload.title !== '' ? payload.title : 'Panel de agentes';
  const options = {
    body: typeof payload.body === 'string' ? payload.body : '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: panelPath(payload.url) },
  };
  // The same tag replaces the previous notice of that chat instead of piling up.
  if (typeof payload.tag === 'string' && payload.tag !== '') {
    options.tag = payload.tag;
    options.renotify = true;
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(
    panelPath(event.notification.data && event.notification.data.url),
    self.location.origin,
  ).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        if ('navigate' in open) await open.navigate(target);
        return;
      }
      await self.clients.openWindow(target);
    }),
  );
});
