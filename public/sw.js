// Minimal service worker: caches the static shell so the app opens fast on phones.
// Game state is never cached; it always comes live over the WebSocket.
const CACHE = 'jackaroo-v2';
const SHELL = ['/', '/index.html', '/app.js', '/style.css', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/healthz') return;
  // network first, fall back to cache (so updates show up immediately when online)
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(url.pathname.startsWith('/g/') ? '/' : e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(url.pathname.startsWith('/g/') ? '/' : e.request)),
  );
});
