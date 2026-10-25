// Operation Macro evening reminder: a Cloudflare Worker that sends a Web Push at 7 pm
// (America/New_York) to phones that haven't logged anything that day.
//
// What it stores (in the SUBS KV namespace), per phone: a random ID, the phone's push
// address, and the last day the phone said "logged today ✓". No food, numbers, email or name.
// It makes its own VAPID keys on first use and keeps them in KV, so there are no secrets to paste.
//
// Setup (Cloudflare dashboard): paste this file as the Worker's code, bind a KV namespace as
// SUBS, and add two Cron Triggers: "0 23 * * *" and "0 0 * * *" (7 pm in summer and in winter;
// the Worker checks the New York hour itself). See worker/README.md.

const ORIGINS = ['https://mr365247.github.io'];
const TZ = 'America/New_York';
const HOUR = 19;
const SUBJECT = 'https://mr365247.github.io/operation-macro/';
const MAX_SUBS = 200;
// Only real browser push services, so the Worker can't be used to POST to arbitrary sites.
const PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    try {
      if (req.method === 'GET' && path === '/key') return json({ key: (await vapidKeys(env)).publicKey });
      if (req.method !== 'POST') return json({ error: 'not found' }, 404);

      const body = await req.json().catch(() => ({}));
      const id = String(body.id || '');
      if (!/^[a-f0-9]{32}$/.test(id)) return json({ error: 'bad id' }, 400);
      const key = 'sub:' + id;

      if (path === '/subscribe') {
        const sub = body.sub || {};
        let host = '';
        try { host = new URL(sub.endpoint).hostname; } catch {}
        if (!/^https:/.test(sub.endpoint || '') || !PUSH_HOSTS.test(host) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
          return json({ error: 'bad subscription' }, 400);
        }
        if (!(await env.SUBS.get(key))) {
          const count = (await env.SUBS.list({ prefix: 'sub:', limit: MAX_SUBS })).keys.length;
          if (count >= MAX_SUBS) return json({ error: 'full' }, 429);
        }
        const rec = { sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, lastLog: validDay(body.day) };
        await env.SUBS.put(key, JSON.stringify(rec));
        return json({ ok: true });
      }
      if (path === '/logged') {
        const rec = JSON.parse((await env.SUBS.get(key)) || 'null');
        if (!rec) return json({ error: 'not subscribed' }, 404);
        const day = validDay(body.day);
        if (day && rec.lastLog !== day) { rec.lastLog = day; await env.SUBS.put(key, JSON.stringify(rec)); }
        return json({ ok: true });
      }
      if (path === '/unsubscribe') {
        await env.SUBS.delete(key);
        return json({ ok: true });
      }
      if (path === '/test') {
        const rec = JSON.parse((await env.SUBS.get(key)) || 'null');
        if (!rec) return json({ error: 'not subscribed' }, 404);
        const status = await sendPush(env, rec.sub, { t: 'test', day: nyDay() });
        return json({ ok: status < 300, status });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env, false));
  },
};

async function runReminders(env, force) {
  if (!force && nyHour() !== HOUR) return { skipped: true };
  const day = nyDay();
  let sent = 0, cursor;
  do {
    const page = await env.SUBS.list({ prefix: 'sub:', cursor });
    for (const { name } of page.keys) {
      const rec = JSON.parse((await env.SUBS.get(name)) || 'null');
      if (!rec || rec.lastLog === day) continue;
      const status = await sendPush(env, rec.sub, { t: 'reminder', day }).catch(() => 0);
      if (status === 404 || status === 410) await env.SUBS.delete(name); // phone turned it off
      else if (status && status < 300) sent++;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return { sent, day };
}

function nyParts() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date());
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}
function nyDay() { const p = nyParts(); return `${p.year}-${p.month}-${p.day}`; }
function nyHour() { return +nyParts().hour; }
function validDay(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null; }

/* ---- Web Push: VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291) ---- */
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
const concat = (...arrs) => { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let i = 0; for (const a of arrs) { out.set(a, i); i += a.length; } return out; };

async function vapidKeys(env) {
  const saved = await env.SUBS.get('_vapid');
  if (saved) return JSON.parse(saved);
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const keys = {
    publicKey: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)),
    privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey),
  };
  await env.SUBS.put('_vapid', JSON.stringify(keys));
  return keys;
}

async function vapidAuth(env, endpoint) {
  const { publicKey, privateJwk } = await vapidKeys(env);
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${publicKey}`;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

// `test` lets the unit test pass fixed keys and salt (RFC 8291 Appendix A).
async function encryptPayload(sub, plaintext, test = {}) {
  const uaPublic = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const as = test.asKeyPair || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = test.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const data = concat(typeof plaintext === 'string' ? enc.encode(plaintext) : plaintext, new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, data));
  const rs = new Uint8Array([0, 0, 0x10, 0]); // 4096-byte records
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

async function sendPush(env, sub, message) {
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': await vapidAuth(env, sub.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '14400', // drop it if the phone is off until after 11 pm
      'Urgency': 'normal',
    },
    body: await encryptPayload(sub, JSON.stringify(message)),
  });
  return res.status;
}
