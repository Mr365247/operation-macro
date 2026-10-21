// Offline cache for the app shell. Bump VERSION whenever you change a file
// so phones pick up the new copy.
const VERSION = 'opmacro-v36';
const FILES = [
  './', './index.html', './style.css', './config.js', './app.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png',
  './vendor/barcode-detector.js', './vendor/zxing_reader.wasm', './vendor/anthropic-sdk.js'
];

self.addEventListener('install', e => {
  // cache: 'reload' skips the phone's HTTP cache so a new version never stores old files.
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (so updates show up when online), fall back to cache offline. 'no-cache' asks
// GitHub Pages whether each file changed instead of reusing a copy for up to 10 minutes.
self.addEventListener('fetch', e => {
  // Only the app's own files; lookups to the food database go straight to the network.
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});
