// Offline cache for the app shell. Bump VERSION whenever you change a file
// so phones pick up the new copy.
const VERSION = 'opmacro-v58';
const PUSH_CACHE = 'opmacro-push'; // what the evening reminder says; written by the app, kept across versions
const FILES = [
  './', './index.html', './style.css', './config.js', './quotes.js', './app.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png',
  './vendor/barcode-detector.js', './vendor/zxing_reader.wasm', './vendor/anthropic-sdk.js'
];

importScripts('quotes.js'); // the evening reminder's quotes, built in so nothing has to be read back

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
// "reminder for <day>". The quote comes from quotes.js. The log streak comes from what the app
// last saved, but iPhone doesn't always let a push read that, so it's a bonus: without it the
// reminder still goes out, just without the streak, and it never waits more than a moment for it.
const prevDay = k => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10); };
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function savedState() {
  const read = Promise.resolve()
    .then(() => caches.open(PUSH_CACHE)).then(c => c.match('state')).then(r => (r ? r.json() : null))
    .catch(() => null);
  return Promise.race([read, new Promise(res => setTimeout(() => res(null), 1500))]);
}
self.addEventListener('push', e => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch {}
  const day = /^\d{4}-\d{2}-\d{2}$/.test(msg.day || '') ? msg.day : localDay();
  e.waitUntil(savedState().then(st => {
    const q = self.opmacroDayQuote(day);
    const quote = `"${q.text}" — ${q.by}\n`;
    let title, body;
    if (msg.t === 'test') {
      title = '🔔 Evening reminder is on';
      body = `${quote}You'll get a nudge at 7 pm on days you haven't logged yet.`;
    } else if (st && st.day === day && st.logged) {
      title = '✓ Logged today';
      body = `${quote}Nice work staying consistent.`;
    } else {
      const alive = st && (st.day === day || (st.day === prevDay(day) && st.logged)) ? st.run : 0;
      title = alive > 0 ? `📝 Keep your ${alive}-day log streak alive` : st ? '📝 Log today, start a streak' : '📝 Time to log today';
      body = `${quote}It's not too late — log some food and stay consistent.`;
    }
    return self.registration.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'opmacro-reminder', data: { day } });
  }));
});
// Tapping it opens the app on the reminder card (streak, quote, Log food).
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const day = (e.notification.data && e.notification.data.day) || localDay();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    if (!list.length) return self.clients.openWindow(new URL('./?nudge=' + day, self.registration.scope).href);
    list[0].postMessage({ nudge: day });
    return list[0].focus();
  }));
});
