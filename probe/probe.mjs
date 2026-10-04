// Scout round 5.
import { writeFile, mkdir } from 'node:fs/promises';
const H = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9',
};
await mkdir('probe/out5', { recursive: true });
const report = [];
async function get(name, url, { headers = {}, grep = [], save = true, ctx = 400 } = {}) {
  const r = { name, url };
  try {
    const res = await fetch(url, { headers: { ...H, ...headers }, redirect: 'follow' });
    r.status = res.status; r.type = res.headers.get('content-type');
    const text = await res.text(); r.bytes = text.length; r.head = text.slice(0, 800); r.text = text;
    if (save) await writeFile(`probe/out5/${name}.txt`, text.slice(0, 3_000_000));
    r.hits = {};
    for (const g of grep) { const re = new RegExp(g, 'g'); const hits = []; let m; while ((m = re.exec(text)) && hits.length < 10) hits.push(text.slice(Math.max(0, m.index - ctx), m.index + ctx)); r.hits[g] = hits; }
  } catch (e) { r.error = e.message; r.cause = e.cause && (e.cause.code || e.cause.message); }
  console.log(name, r.status || r.error, r.bytes || '');
  const { text, ...rest } = r; report.push(rest);
  return r;
}
const json = r => { try { return JSON.parse(r.text); } catch { return null; } };
// Wendy's
const wb = 'https://api.app.prd.wendys.digital/web-client-gateway';
const wh = { Origin: 'https://order.wendys.com', Referer: 'https://order.wendys.com/' };
let n = 0;
outer: for (const sc of ['ORDER.WENDYS', 'WEB', 'WENDYS.WEB', 'ORDER_WENDYS', 'NEXTGEN']) for (const v of ['2.21.2', '22.1.2']) {
  const r = await get(`wendys-${n++}`, `${wb}/menu/getSiteMenu?siteNum=0&freeStyleMenu=true&menuChannel=WEB_GUEST&lang=en&cntry=US&sourceCode=${sc}&version=${v}`, { headers: wh, save: false });
  if (r.status === 200) { await writeFile('probe/out5/wendys-menu.txt', r.text); break outer; }
}
// Chipotle universal menu
const ch = { 'Ocp-Apim-Subscription-Key': 'b4d9f36380184a3788857063bce25d6a', Origin: 'https://www.chipotle.com', Referer: 'https://www.chipotle.com/' };
await get('chipotle-appjs', 'https://orderweb-cdn.chipotle.com/js/app.js', { save: false, grep: ['universalmenus/online', 'universalmeals/online'] });
for (const q of ['country=US', 'country=US&channelId=web', 'country=US&channelId=web&includeUnavailableItems=true']) await get('chipotle-umenu-' + q.replace(/[^a-z]/gi, ''), `https://services.chipotle.com/menuinnovation/v1/universalmenus/online?${q}`, { headers: ch });
await get('chipotle-umeals', 'https://services.chipotle.com/menuinnovation/v1/universalmeals/online?country=US', { headers: ch });
// Panera: default cafe 500000
const ph = { Origin: 'https://www.panerabread.com', Referer: 'https://www.panerabread.com/' };
const pb = 'https://www-api.panerabread.com/www-api';
const ver = await get('panera-version', `${pb}/public/menu/version/500000`, { headers: ph });
const vj = json(ver);
const versionId = vj && (vj.aggregateVersion || vj.versionId || vj.menuVersion || vj.version || (Array.isArray(vj) && vj[0]));
console.log('panera versionId guess', JSON.stringify(versionId).slice(0, 100));
if (versionId) {
  const hs = await get('panera-hashes', `${pb}/public/menu/placard/hashes/v2/500000/version/${typeof versionId === 'object' ? JSON.stringify(versionId) : versionId}/en-US`, { headers: ph });
  const hj = json(hs);
  const hashes = hj ? JSON.stringify(hj).match(/[a-f0-9]{24,}/g) || [] : [];
  for (const h of [...new Set(hashes)].slice(0, 3)) await get('panera-placard-' + h.slice(0, 8), `${pb}/public/menu/placard/hash/${h}`, { headers: ph });
}
await get('panera-js', 'https://www.panerabread.com/content/dam/panerabread/static/www-ui/2.97.1-3ed67cfe/js/www-ui.min.js', { save: false, ctx: 300, grep: ['placard/hashes/v2', 'menu/version/', 'item/price/nutrition'] });
await writeFile('probe/report5.json', JSON.stringify(report, null, 1));
