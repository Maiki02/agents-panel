import { Injectable } from '@angular/core';
import type { PushEnvironment } from './notifications-logic';
import { urlBase64ToBytes } from './notifications-logic';

const SW_URL = '/push-sw.js';

/** The browser side of Web Push: permission, service worker and `PushManager`. */
@Injectable({ providedIn: 'root' })
export class PushBrowser {
  /** What this browser offers; `serverEnabled` and `subscribed` are filled in by the page. */
  environment(): Omit<PushEnvironment, 'serverEnabled' | 'subscribed'> {
    const agent = navigator.userAgent;
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as { standalone?: boolean }).standalone === true;
    return {
      secureContext: window.isSecureContext,
      hasServiceWorker: 'serviceWorker' in navigator,
      hasPushManager: 'PushManager' in window,
      hasNotification: 'Notification' in window,
      permission: 'Notification' in window ? Notification.permission : 'denied',
      // iPadOS says "Macintosh": a touch screen tells it apart from a Mac.
      isIos:
        /iPhone|iPad|iPod/.test(agent) ||
        (agent.includes('Macintosh') && navigator.maxTouchPoints > 1),
      isStandalone: standalone,
    };
  }

  userAgent(): string {
    return navigator.userAgent;
  }

  /** The subscription this browser already has, if any. */
  async current(): Promise<PushSubscription | null> {
    if (!('serviceWorker' in navigator)) return null;
    const registration = await navigator.serviceWorker.getRegistration(SW_URL);
    return registration ? registration.pushManager.getSubscription() : null;
  }

  /** Asks for permission, registers the service worker and subscribes with the panel's key. */
  async subscribe(publicKey: string): Promise<PushSubscription> {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('No diste permiso para las notificaciones.');
    await navigator.serviceWorker.register(SW_URL);
    const registration = await navigator.serviceWorker.ready;
    return registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(publicKey),
    });
  }

  /** Drops the browser's own subscription (the panel's row is removed separately). */
  async unsubscribe(): Promise<void> {
    await (await this.current())?.unsubscribe();
  }
}
