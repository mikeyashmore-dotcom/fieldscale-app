// Fieldscale service worker — makes the app installable and keeps the shell available offline.
// Safe by design: API calls and cross-origin requests always go to the network (data stays live);
// only same-origin static assets and page HTML are cached.
const CACHE = 'fieldscale-v1';
const SHELL = ['/fs-theme.css', '/app-nav.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))  // don't fail install if one asset 404s
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;         // fonts / CDNs → network
  if (url.pathname.startsWith('/api/')) return;        // never cache API — must be live

  // Pages: network-first so app logic stays fresh; fall back to cache when offline.
  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith(
      fetch(req)
        .then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return r; })
        .catch(() => caches.match(req).then((m) => m || caches.match('/home.html')))
    );
    return;
  }

  // Static assets: serve from cache instantly, refresh in the background (stale-while-revalidate).
  e.respondWith(
    caches.match(req).then((m) => {
      const net = fetch(req)
        .then((r) => { if (r && r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); } return r; })
        .catch(() => m);
      return m || net;
    })
  );
});
