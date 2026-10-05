/**
 * Browser push subscription management.
 *
 * Flow: fetch the server's VAPID public key, ask permission, subscribe
 * through the service worker registration, POST the subscription up. Every
 * step can fail (denied permission, no service worker, push unsupported),
 * and each failure has its own message so the settings screen can say what
 * actually happened instead of a generic error.
 */

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  // globalThis.atob exists in browsers and in Node, unlike window.atob.
  const raw = globalThis.atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  // Sized construction yields Uint8Array<ArrayBuffer>, which satisfies
  // BufferSource; Uint8Array.from would widen to ArrayBufferLike and not.
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export type PushState =
  | { kind: 'unsupported' }
  | { kind: 'denied' }
  | { kind: 'unsubscribed' }
  | { kind: 'subscribed'; endpoint: string };

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return { kind: 'unsupported' };
  if (Notification.permission === 'denied') return { kind: 'denied' };
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) return { kind: 'subscribed', endpoint: subscription.endpoint };
    return { kind: 'unsubscribed' };
  } catch {
    return { kind: 'unsupported' };
  }
}

/**
 * Subscribe this browser and return the subscription JSON for the server.
 * Throws an Error with a human-readable message on every failure path.
 */
export async function subscribeBrowser(
  vapidPublicKey: string,
): Promise<{ endpoint: string; keys: { p256dh: string; auth: string } }> {
  if (!pushSupported()) throw new Error('This browser does not support push notifications.');
  if (Notification.permission === 'denied') {
    throw new Error('Notifications are blocked for this site. Allow them in the browser settings first.');
  }
  if (Notification.permission !== 'granted') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notification permission was not granted.');
  }
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('The browser returned an incomplete subscription.');
  }
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
}

export async function unsubscribeBrowser(): Promise<string | null> {
  if (!pushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return null;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    return endpoint;
  } catch {
    return null;
  }
}
