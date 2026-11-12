/*
 * Nuggets service worker.
 *
 * Exists for two things: it makes the app an installable PWA (Android/iOS
 * "Install app" / "Add to Home Screen"), and it is the only place a browser
 * can receive Web Push messages and show them as system notifications.
 *
 * It deliberately has NO fetch handler and caches nothing. Every request goes
 * straight to the network exactly as it would without a service worker, so a
 * deploy can never be masked by a stale cached index.html or chunk.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Payload: JSON { title, body?, url?, tag? } — or plain text used as the body.
self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { body: event.data.text() };
    }
  }

  const title = data.title || 'Nuggets';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icon-192.png',
      tag: data.tag,
      data: { url: data.url || '/' },
    })
  );
});

/**
 * The page a notification opens: its URL when that is a page of this app, else the
 * home page. A push payload naming another site (`https://evil.example`,
 * `//evil.example`) must not take the person there.
 */
function notificationTarget(url) {
  try {
    const target = new URL(url || '/', self.location.origin);
    if (target.origin === self.location.origin) return target.href;
  } catch {
    // Not a URL: the home page.
  }
  return new URL('/', self.location.origin).href;
}

// Focus an open Nuggets window (navigating it to the notification's URL), or
// open a new one if none is open.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = notificationTarget(event.notification.data?.url);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          return client.focus().then((focused) => (focused && 'navigate' in focused ? focused.navigate(target) : focused));
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
