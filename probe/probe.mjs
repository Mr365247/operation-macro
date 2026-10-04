// Scout round 4.
import { writeFile, mkdir } from 'node:fs/promises';
const H = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"',
};
await mkdir('probe/out4', { recursive: true });
const report = [];
async function get(name, url, { headers = {}, grep = [], save = true, ctx = 300, uniq } = {}) {
  const r = { name, url };
  try {
    const res = await fetch(url, { headers: { ...H, ...headers }, redirect: 'follow' });
    r.status = res.status; r.type = res.headers.get('content-type');
    const text = await res.text(); r.bytes = text.length; r.head = text.slice(0, 600);
    if (save) await writeFile(`probe/out4/${name}.txt`, text.slice(0, 2_500_000));
    r.hits = {};
    for (const g of grep) {
      const re = new RegExp(g, 'g'); const hits = []; let m;
      while ((m = re.exec(text)) && hits.length < 25) hits.push(uniq ? m[0] : text.slice(Math.max(0, m.index - ctx), m.index + ctx));
      r.hits[g] = uniq ? [...new Set(hits)] : hits;
    }
  } catch (e) { r.error = e.message; r.cause = e.cause && (e.cause.code || e.cause.message); }
  report.push(r);
  console.log(name, r.status || r.error, r.bytes || '');
  return r;
}
// Wendy's national menu
const wb = 'https://api.app.prd.wendys.digital/web-client-gateway';
const wh = { Origin: 'https://order.wendys.com', Referer: 'https://order.wendys.com/' };
for (const site of ['0', '1', 'national']) await get('wendys-menu-' + site, `${wb}/menu/getSiteMenu?siteNum=${site}&freeStyleMenu=true&menuChannel=WEB_GUEST&lang=en&cntry=US`, { headers: wh });
await get('wendys-chunk-k2', 'https://order.wendys.com/_next/static/chunks/2336-435cb938336ca8d4.js', { save: false, ctx: 200, grep: ['k2=\\{', 'NATIONAL', 'national[A-Za-z]*:"?\\d+'] });
// Panera: default cafe + menu version
await get('panera-js', 'https://www.panerabread.com/content/dam/panerabread/static/www-ui/2.97.1-3ed67cfe/js/www-ui.min.js', { save: false, ctx: 200, grep: ['defaultCafe', 'DEFAULT_CAFE', 'nationalCafe', 'cafeId:\\s*\\d{3,}', 'cafeId=\\d{3,}', '"\\d{6}"\\s*[,}]'] });
const ph = { Origin: 'https://www.panerabread.com', Referer: 'https://www.panerabread.com/' };
for (const cafe of ['203301', '600000', '203156']) await get('panera-version-' + cafe, `https://www-api.panerabread.com/www-api/public/menu/version/${cafe}`, { headers: ph });
await get('panera-cafe-search', 'https://www-api.panerabread.com/www-api/public/cafe/search?zip=02904&radius=25', { headers: ph });
// Chipotle: where the gateway url/key come from
await get('chipotle-appjs', 'https://orderweb-cdn.chipotle.com/js/app.js', { save: false, grep: ['gatewaySubscriptionKey[^,;]{0,120}', 'gatewayUrl[^,;]{0,120}', '[a-zA-Z0-9_./-]*config[a-zA-Z0-9_./-]*\\.json', 'menuinnovation/v1/[A-Za-z/${}.]+', 'https://[a-z0-9.-]*chipotle\\.com[^"\'`\\s]*'], uniq: true });
await writeFile('probe/report4.json', JSON.stringify(report, null, 1));
