/**
 * Custom service worker: precached app shell plus push handling.
 *
 * generateSW cannot do this — it emits a fixed worker with no place for a
 * 'push' listener — so the build uses injectManifest and this file instead.
 * The caching contract is unchanged from the generateSW days: the shell is
 * precached and works offline, while /api/* always goes to the network,
 * because a stale ledger is worse than none.
 */
import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkOnly } from 'workbox-strategies';

declare const self: ServiceWorkerGlobalScope;

// Injected at build time by vite-plugin-pwa (injectManifest). Read through a
// cast rather than an interface augmentation: augmenting
// ServiceWorkerGlobalScope risks a declaration conflict, while this cannot.
const manifest = (
  self as unknown as { __WB_MANIFEST: { revision: string | null; url: string }[] }
).__WB_MANIFEST;

precacheAndRoute(manifest);

registerRoute(
  ({ url }) => url.pathname.startsWith('/api/'),
  new NetworkOnly(),
);

interface ReminderPayload {
  title?: string;
  body?: string;
  occurrenceId?: string;
  date?: string;
}

self.addEventListener('push', (event: PushEvent) => {
  let payload: ReminderPayload = {};
  try {
    if (event.data) payload = event.data.json() as ReminderPayload;
  } catch {
    // A push without usable JSON still deserves a visible notification.
  }
  const title = payload.title || 'Takalif';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || 'Something is due.',
      tag: payload.occurrenceId ?? 'takalif-reminder',
      data: { date: payload.date },
    }),
  );
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const date = (event.notification.data as { date?: string } | null)?.date;
  const url = date ? `/?date=${date}` : '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if ('focus' in client) {
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
