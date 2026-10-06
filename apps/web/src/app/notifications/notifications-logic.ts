/** What the browser offers, read once by the page; the pure logic below decides from it. */
export interface PushEnvironment {
  /** The panel has VAPID keys (GET /api/push/config). */
  serverEnabled: boolean;
  secureContext: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  permission: 'default' | 'granted' | 'denied';
  isIos: boolean;
  /** Opened from the home screen icon (iOS only delivers push there). */
  isStandalone: boolean;
  /** This browser already has a subscription saved in the panel. */
  subscribed: boolean;
}

export type PushSupportKind =
  'ready' | 'subscribed' | 'disabled' | 'insecure' | 'ios_install' | 'unsupported' | 'denied';

export interface PushSupport {
  kind: PushSupportKind;
  /** Why the activate button is disabled; null when it can be pressed. */
  reason: string | null;
}

/** First problem found, in the order the user can fix them; `ready` when none. */
export function pushSupport(env: PushEnvironment): PushSupport {
  if (!env.serverEnabled) {
    return {
      kind: 'disabled',
      reason:
        'Las notificaciones no están activadas en el panel: faltan las claves VAPID en su .env (ver docs/panel-desarrollo.md).',
    };
  }
  if (!env.secureContext) {
    return {
      kind: 'insecure',
      reason:
        'Las notificaciones necesitan HTTPS o localhost: entrá por la URL de Funnel o por el túnel.',
    };
  }
  if (env.isIos && !env.isStandalone) {
    return {
      kind: 'ios_install',
      reason:
        'En iPhone y iPad hay que agregar el panel a la pantalla de inicio (Compartir → Agregar a inicio) y abrirlo desde ahí.',
    };
  }
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) {
    return { kind: 'unsupported', reason: 'Este navegador no soporta notificaciones push.' };
  }
  if (env.permission === 'denied') {
    return {
      kind: 'denied',
      reason:
        'Bloqueaste las notificaciones de este sitio: habilitalas desde los permisos del navegador y recargá.',
    };
  }
  if (env.subscribed) {
    return { kind: 'subscribed', reason: 'Este dispositivo ya recibe avisos.' };
  }
  return { kind: 'ready', reason: null };
}

/** "Chrome en Windows": a name for the device the user can recognize in the list. */
export function suggestedName(userAgent: string): string {
  const os = userAgent.includes('iPhone')
    ? 'iPhone'
    : userAgent.includes('iPad')
      ? 'iPad'
      : userAgent.includes('Android')
        ? 'Android'
        : userAgent.includes('Windows')
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(userAgent)
            ? 'Mac'
            : /Linux|X11/.test(userAgent)
              ? 'Linux'
              : null;
  // Order matters: Edge and Opera also say Chrome, and Chrome also says Safari.
  const browser = userAgent.includes('Edg/')
    ? 'Edge'
    : /OPR\/|Opera/.test(userAgent)
      ? 'Opera'
      : /Firefox\/|FxiOS/.test(userAgent)
        ? 'Firefox'
        : /Chrome\/|CriOS/.test(userAgent)
          ? 'Chrome'
          : userAgent.includes('Safari/')
            ? 'Safari'
            : null;
  if (browser !== null && os !== null) return `${browser} en ${os}`;
  return browser ?? os ?? 'Este dispositivo';
}

/** The VAPID public key (URL-safe base64) as the bytes `PushManager.subscribe` wants. */
export function urlBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** The body of POST /api/push/subscriptions from a browser subscription; null if it lacks keys. */
export function subscriptionBody(
  json: { endpoint?: string; keys?: Record<string, string> },
  name: string,
): { endpoint: string; keys: { p256dh: string; auth: string }; name: string } | null {
  const { endpoint, keys } = json;
  if (endpoint === undefined || keys?.['p256dh'] === undefined || keys['auth'] === undefined) {
    return null;
  }
  return { endpoint, keys: { p256dh: keys['p256dh'], auth: keys['auth'] }, name };
}

/** Result of the "Probar" button, in words. */
export function testMessage(result: {
  sent: boolean;
  removed: boolean;
  statusCode: number | null;
}): string {
  if (result.sent) return 'Aviso de prueba enviado: debería llegar en unos segundos.';
  if (result.removed) {
    return 'El navegador ya no acepta avisos en ese dispositivo: se quitó de la lista. Activalo de nuevo.';
  }
  return `No se pudo enviar el aviso${result.statusCode === null ? '' : ` (el servicio de push respondió ${String(result.statusCode)})`}.`;
}
