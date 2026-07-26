/* Fieldscale service worker — offline field mode.
   - App shell + assets: stale-while-revalidate (open offline, update in background).
   - API GET: network-first, fall back to the last cached copy so a crew can read a job with no signal.
   - API writes (POST/PUT/DELETE) made while offline: queued in IndexedDB and replayed when back online.
   Bump CACHE to force a refresh of cached shell files. */
const CACHE = 'fieldscale-v1';
const CORE = [
  '/home.html', '/jobs.html', '/job.html', '/schedule.html', '/plans.html', '/floorplan.html',
  '/leads.html', '/lead.html', '/estimates.html', '/proposals.html', '/invoices.html',
  '/app-nav.js', '/fs-theme.css', '/manifest.webmanifest', '/icon-192.png', '/apple-touch-icon.png'
];
// Auth endpoints must never be queued/replayed — they only make sense live.
const NO_QUEUE = /\/api\/(login|register|refresh|logout)\b/;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(CORE.map(u => c.add(u).catch(() => {}))); // resilient: a missing file won't block install
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;            // fonts/CDN: straight to network
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(req.method === 'GET' ? apiGet(req) : apiWrite(req));
  } else {
    e.respondWith(shell(req));
  }
});

// App shell + static assets: network-first (always fresh when online, so a new deploy shows
// immediately), refreshing the cache on success and falling back to it only when offline.
async function shell(req) {
  const cache = await caches.open(CACHE);
  try {
    const resp = await fetch(req);
    if (resp && resp.ok && req.method === 'GET') cache.put(req, resp.clone());
    return resp;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    if (req.mode === 'navigate') { const home = await cache.match('/home.html'); if (home) return home; }
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

// API reads: try the network, cache good responses, fall back to cache when offline.
async function apiGet(req) {
  const cache = await caches.open(CACHE);
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) cache.put(req, resp.clone());
    return resp;
  } catch (e) {
    const c = await cache.match(req);
    if (c) return c;
    return json({ offline: true, error: "Not saved for offline yet — open this once while you have signal." }, 503);
  }
}

// API writes: pass through when online; when the network is down, queue and acknowledge.
async function apiWrite(req) {
  const url = new URL(req.url);
  try {
    return await fetch(req.clone());
  } catch (e) {
    if (NO_QUEUE.test(url.pathname)) return json({ offline: true, error: 'You are offline.' }, 503);
    await enqueue(req.clone());
    try { await self.registration.sync.register('fs-sync'); } catch (_) {}
    return json({ queued: true, offline: true }, 202);
  }
}
function json(obj, status) { return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }); }

// ---- Outbox (IndexedDB) ----
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('fs-outbox', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('q', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function qAdd(rec) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('q', 'readwrite'); tx.objectStore('q').add(rec); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
async function qAll() { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('q', 'readonly'); const rq = tx.objectStore('q').getAll(); rq.onsuccess = () => res(rq.result || []); rq.onerror = () => rej(rq.error); }); }
async function qDel(id) { const db = await idb(); return new Promise((res) => { const tx = db.transaction('q', 'readwrite'); tx.objectStore('q').delete(id); tx.oncomplete = res; }); }

async function enqueue(req) {
  const body = await req.clone().text();
  const headers = {};
  for (const [k, v] of req.headers) headers[k] = v;
  await qAdd({ url: req.url, method: req.method, headers, body, ts: Date.now() });
  broadcast();
}
// Replay queued writes in order. Stop on network failure (still offline) or a server error (5xx);
// drop a request the server rejects with a 4xx so it can't wedge the queue forever.
async function flush() {
  const items = await qAll();
  for (const it of items) {
    try {
      const resp = await fetch(it.url, { method: it.method, headers: it.headers, body: it.body });
      if (resp && resp.status < 500) await qDel(it.id);
      else break;
    } catch (e) { break; }
  }
  broadcast();
}
async function broadcast() {
  const n = (await qAll()).length;
  const cs = await self.clients.matchAll({ includeUncontrolled: true });
  cs.forEach(c => c.postMessage({ type: 'fs-outbox', count: n }));
}

self.addEventListener('sync', e => { if (e.tag === 'fs-sync') e.waitUntil(flush()); });
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d === 'flush' || d.type === 'flush') e.waitUntil(flush());
  if (d.type === 'count') e.waitUntil(broadcast());
  if (d.type === 'skipWaiting') self.skipWaiting();
});
