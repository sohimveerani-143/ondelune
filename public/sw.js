const CACHE_NAME = 'tidelight-v4';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/crypto.js',
  './js/store.js',
  './js/firebase.js',
  './js/firebase-config.js',
  './js/pairing.js',
  './js/room-data.js',
  './js/image-utils.js',
  './js/applock.js',
  './js/auth-recovery.js',
  './js/streak.js',
  './js/ui.js',
  './js/presence.js',
  './js/notify.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for the app's own code, cache-first for everything else local.
// Cache-first on JS is what made stale builds so sticky in this project before:
// a shipped fix would sit unused behind an old cached module until the cache
// name changed. Now a reachable network always wins, and the cache is the
// offline fallback it was meant to be.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // CDN/Firebase pass straight through
  if (event.request.method !== 'GET') return;

  const isAppCode = /\.(js|css|webmanifest)$/.test(url.pathname) || url.pathname.endsWith('/') || url.pathname.endsWith('index.html');

  if (isAppCode) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});

// Tapping a notification should focus the existing window rather than opening
// a second copy of the app.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});
