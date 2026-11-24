// DashPad service worker: the dashboard must start and show the last known data without internet
// (routers often die during blackouts). Live data stays network-first; the app keeps its own copy in localStorage.
const CACHE = 'dashpad-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

function networkFirst(request, cacheKey) {
  return fetch(request)
    .then((r) => {
      if (r.ok) {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(cacheKey, copy));
      }
      return r;
    })
    .catch(() => caches.match(cacheKey, { ignoreSearch: true }).then((hit) => hit || Response.error()));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname === '/version.json') return; // always network
  if (req.mode === 'navigate' && url.pathname === '/') return e.respondWith(networkFirst(req, '/'));
  // «Ход работ» page and its data: show the last copy when offline
  if (url.pathname === '/progress') return e.respondWith(networkFirst(req, '/progress'));
  if (url.pathname === '/api/progress') {
    if (req.headers.has('If-None-Match')) return; // 304 polling: let it fail offline, the page keeps what it has
    return e.respondWith(networkFirst(req, '/api/progress'));
  }
  if (url.pathname.startsWith('/api/')) return; // other live data: network only
  // hashed build assets and fonts: cache first
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((r) => {
          if (r.ok) {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return r;
        }),
    ),
  );
});
