// Minimal service worker: caches the static shell so the app opens fast on phones.
// Game state is never cached; it always comes live over the WebSocket.
const CACHE = 'jackaroo-v4';
const SHELL = ['./', './index.html', './app.js', './p2p.js', './config.js', './style.css', './manifest.webmanifest', './icons/icon.svg', './vendor/peerjs.min.js', './shared/engine.js', './shared/host.js', './shared/rng.js', './shared/layout.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (/\/(api\/|ws$|healthz$)/.test(url.pathname)) return;
  // network first, fall back to cache (so updates show up immediately when online)
  const key = new Request(url.origin + url.pathname); // ignore ?g=CODE
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(key)),
  );
});
