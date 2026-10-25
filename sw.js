// Offline cache for the app shell. Bump VERSION whenever you change a file
// so phones pick up the new copy.
const VERSION = 'opmacro-v57';
const PUSH_CACHE = 'opmacro-push'; // what the evening reminder says; written by the app, kept across versions
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
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== PUSH_CACHE).map(k => caches.delete(k))))
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

// Evening reminder from the Cloudflare Worker (worker/push-worker.js). The push only says
// "reminder for <day>"; the words come from what the app last saved here: the log streak
// and a quote for each of the next few days.
const prevDay = k => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10); };
self.addEventListener('push', e => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(caches.open(PUSH_CACHE).then(c => c.match('state')).then(r => r ? r.json() : null).catch(() => null).then(st => {
    const day = msg.day || '';
    const q = st && st.quotes && (st.quotes[day] || Object.values(st.quotes)[0]);
    const quote = q ? `"${q.text}" — ${q.by}\n` : '';
    let title, body;
    if (msg.t === 'test') {
      title = '🔔 Evening reminder is on';
      body = `${quote}You'll get a nudge at 7 pm on days you haven't logged yet.`;
    } else if (st && st.day === day && st.logged) {
      title = '✓ Logged today';
      body = `${quote}Nice work staying consistent.`;
    } else {
      const alive = st && (st.day === day || (st.day === prevDay(day) && st.logged)) ? st.run : 0;
      title = alive > 0 ? `📝 Keep your ${alive}-day log streak alive` : '📝 Log today, start a streak';
      body = `${quote}It's not too late — log some food and stay consistent.`;
    }
    return self.registration.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'opmacro-reminder' });
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(list => list.length ? list[0].focus() : self.clients.openWindow('./')));
});
