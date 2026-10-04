// Scout round 2.
import { writeFile, mkdir } from 'node:fs/promises';
const H = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'gzip, deflate, br',
  'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"',
  'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1',
};
await mkdir('probe/out2', { recursive: true });
const report = [];
async function get(name, url, opts = {}) {
  const r = { name, url };
  try {
    const res = await fetch(url, { headers: { ...H, ...(opts.headers || {}) }, redirect: 'follow' });
    r.status = res.status; r.finalUrl = res.url; r.type = res.headers.get('content-type');
    const text = await res.text(); r.bytes = text.length;
    r.head = text.slice(0, 300);
    if (opts.save !== false) await writeFile(`probe/out2/${name}.txt`, text.slice(0, opts.max || 1_500_000));
    if (opts.grep) {
      r.hits = {};
      for (const g of opts.grep) {
        const re = new RegExp(g, 'gi'); const hits = []; let m;
        while ((m = re.exec(text)) && hits.length < 12) hits.push(text.slice(Math.max(0, m.index - 250), m.index + 350));
        r.hits[g] = hits;
      }
    }
    r.links = [...new Set(text.match(/https?:\/\/[^"'\s<>()\\]+/g) || [])].filter(l => /api|json|nutri|menu|pdf|\.js/i.test(l)).slice(0, 150);
  } catch (e) { r.error = e.message; r.cause = e.cause && (e.cause.code || e.cause.message); }
  report.push(r);
  console.log(name, r.status || r.error, r.cause || '', r.bytes || '');
  return r;
}
// Chipotle: ordering app code holds the API base + key
await get('chipotle-appjs', 'https://orderweb-cdn.chipotle.com/js/app.js', { save: false, grep: ['Ocp-Apim-Subscription-Key', 'menuinnovation', 'nutrition', 'services\\.chipotle\\.com/[a-z]'] });
// Wendy's
await get('wendys-menu', 'https://menu.wendys.com/');
await get('wendys-order', 'https://order.wendys.com/categories?site=menu&lang=en_US');
await get('wendys-api', 'https://digitalservices.prod.ext-aws.wendys.com/menu/getSiteMenu?lang=en&cntry=US&sourceCode=ORDER.WENDYS&version=22.1.2&siteNum=0', { headers: { Accept: 'application/json' } });
// McDonald's
await get('mcd-calc', 'https://www.mcdonalds.com/us/en-us/about-our-food/nutrition-calculator.html');
await get('mcd-bigmac', 'https://www.mcdonalds.com/us/en-us/product/big-mac.html');
// Panera
await get('panera-menu', 'https://www.panerabread.com/en-us/menu.html');
await get('panera-pdf', 'https://www.panerabread.com/content/dam/panerabread/documents/nutrition/panera-nutrition.pdf');
// Subway
await get('subway-home', 'https://www.subway.com/en-US');
await get('subway-nutrition', 'https://www.subway.com/en-US/MenuNutrition/Nutrition');
await writeFile('probe/report2.json', JSON.stringify(report, null, 1));
