// Scout round 6: Chipotle restaurant menu (nutrition).
import { writeFile, mkdir } from 'node:fs/promises';
await mkdir('probe/out6', { recursive: true });
const H = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*', 'Ocp-Apim-Subscription-Key': 'b4d9f36380184a3788857063bce25d6a', Origin: 'https://www.chipotle.com', Referer: 'https://www.chipotle.com/' };
const report = [];
// LZ4 block decompression (Chipotle's site sends its menu compressed this way).
function lz4(src, outLen) {
  const out = new Uint8Array(outLen); let i = 0, o = 0;
  while (i < src.length) {
    const tok = src[i++]; let lit = tok >> 4;
    if (lit === 15) { let b; do { b = src[i++]; lit += b; } while (b === 255); }
    for (let k = 0; k < lit; k++) out[o++] = src[i++];
    if (i >= src.length) break;
    const off = src[i] | (src[i + 1] << 8); i += 2;
    let ml = tok & 15;
    if (ml === 15) { let b; do { b = src[i++]; ml += b; } while (b === 255); }
    ml += 4;
    for (let k = 0; k < ml; k++, o++) out[o] = out[o - off];
  }
  return out.subarray(0, o);
}
async function get(name, url) {
  const r = { name, url };
  try { const res = await fetch(url, { headers: H }); r.status = res.status; const t = await res.text(); r.bytes = t.length; r.head = t.slice(0, 500); r.text = t; }
  catch (e) { r.error = e.message; }
  console.log(name, r.status || r.error, r.bytes || '');
  const { text, ...rest } = r; report.push(rest); return r;
}
const app = await get('appjs', 'https://orderweb-cdn.chipotle.com/js/app.js');
const grab = (re, n = 12, ctx = 300) => { const out = []; let m; const g = new RegExp(re, 'g'); while ((m = g.exec(app.text || '')) && out.length < n) out.push(app.text.slice(Math.max(0, m.index - ctx), m.index + ctx)); return out; };
report.push({ name: 'appjs-hits', calories: grab('calories', 8), nutrition: grab('nutritionInfo|nutritionalInfo|\\.nutrition\\b', 8), restaurantApi: grab('restaurant/v\\d[^`"\']{0,80}', 8, 150) });
let found = false;
for (const id of ['1', '2', '3', '10', '100', '1000', '2000', '2500', '3000', '4000']) {
  const plain = await get('menu-' + id, `https://services.chipotle.com/menuinnovation/v1/restaurants/${id}/onlinemenu?channelId=web&includeUnavailableItems=true`);
  if (plain.status === 200) { await writeFile('probe/out6/menu-plain.json', plain.text); found = true; }
  const comp = await get('menuc-' + id, `https://services.chipotle.com/menuinnovation/v1/restaurants/${id}/onlinemenu/compressed?channelId=web&includeUnavailableItems=true`);
  if (comp.status === 200) {
    try {
      const j = JSON.parse(comp.text);
      const bytes = Uint8Array.from(Buffer.from(j.compressedMenu, 'base64'));
      await writeFile('probe/out6/menu-decompressed.json', Buffer.from(lz4(bytes, j.decompressedMenuSize)).toString('utf8'));
      found = true;
    } catch (e) { report.push({ name: 'decompress-error-' + id, error: e.message }); }
  }
  if (found) break;
}
await writeFile('probe/report6.json', JSON.stringify(report, null, 1));
