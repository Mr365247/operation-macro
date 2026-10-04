// Scout round 3.
import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const H = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"',
};
await mkdir('probe/out3', { recursive: true });
const report = [];
async function get(name, url, { headers = {}, grep = [], save = true, ctx = 300, binary = false } = {}) {
  const r = { name, url };
  try {
    const res = await fetch(url, { headers: { ...H, ...headers }, redirect: 'follow' });
    r.status = res.status; r.type = res.headers.get('content-type');
    if (binary) {
      const buf = Buffer.from(await res.arrayBuffer()); r.bytes = buf.length;
      await writeFile(`probe/out3/${name}.pdf`, buf);
      try { execFileSync('pdftotext', ['-layout', `probe/out3/${name}.pdf`, `probe/out3/${name}.txt`]); } catch (e) { r.pdfErr = e.message; }
    } else {
      const text = await res.text(); r.bytes = text.length; r.head = text.slice(0, 400);
      if (save) await writeFile(`probe/out3/${name}.txt`, text.slice(0, 1_500_000));
      r.hits = {};
      for (const g of grep) {
        const re = new RegExp(g, 'g'); const hits = []; let m;
        while ((m = re.exec(text)) && hits.length < 15) hits.push(text.slice(Math.max(0, m.index - ctx), m.index + ctx));
        r.hits[g] = hits;
      }
    }
  } catch (e) { r.error = e.message; r.cause = e.cause && (e.cause.code || e.cause.message); }
  report.push(r);
  console.log(name, r.status || r.error, r.bytes || '');
  return r;
}
// McDonald's: calculator script + data endpoint variants
const mcdHdr = { Referer: 'https://www.mcdonalds.com/us/en-us/about-our-food/nutrition-calculator.html', Accept: 'application/json, text/plain, */*' };
await get('mcd-calcjs', 'https://www.mcdonalds.com/etc.clientlibs/mcdonalds/clientlibs/clientlib-site-nutrition-calculator.lc-bdc0c6258eeb128cdd18d55f458b3f77-lc.min.js', { save: false, grep: ['itemList', 'itemDetails', 'getProductItemDetails', 'showLiveData'] });
await get('mcd-list', 'https://www.mcdonalds.com/dnaapp/itemList?country=US&language=en&showLiveData=true&item=200463-200626', { headers: mcdHdr });
await get('mcd-details', 'https://www.mcdonalds.com/dnaapp/itemDetails?country=US&language=en&showLiveData=true&item=200463', { headers: mcdHdr });
await get('mcd-details2', 'https://www.mcdonalds.com/dnaapp/itemDetails?country=US&language=en&showLiveData=true&item=200463&nutrient_req=Y', { headers: mcdHdr });
// Subway: official nutrition PDF
await get('subway-pdf', 'https://media.subway.com/dam/urn:aaid:aem:f20a4541-8c88-496b-940d-4aa8318cae26/original/as/us-nutrition-en.pdf', { binary: true });
// Chipotle: API base + key in the ordering app
await get('chipotle-appjs', 'https://orderweb-cdn.chipotle.com/js/app.js', { save: false, ctx: 500, grep: ['azure-api', 'apim', 'function Vt\\(', 'Vt=function', 'function Gt\\(', 'Gt=function', 'menuinnovation/v1/restaurants/\\$\\{e\\}/onlinemenu', 'nutrition-calculator', 'NutritionCalculator'] });
// Wendy's: Next.js chunks; look for the menu API paths
const wChunks = ['8732-70616c441883118b', 'main-app-62f67d5f96c9751c', '7907-792cda3786d96161', '4392-45ebdd9bf3960eb0', '4464-4ae544fa25b3ab7c', '48-1ad4736bf8495ed1', '8644-de9cc0a5b3d27d5c', '8770-88b2ef4e6a4d7f7b', '6112-d9b3f0d6a225ecd6', '8343-195c5bb30d7983e6', '1245-716a3859e9dd50f7', '2336-435cb938336ca8d4', '4533-07e06bda16064fd2', 'app/%5Blocale%5D/national/menu/page-d75c7d7dc4f1fc89'];
for (const c of wChunks) await get('wendys-' + c.replace(/[^a-z0-9]+/gi, '_'), `https://order.wendys.com/_next/static/chunks/${c}.js`, { save: false, ctx: 250, grep: ['/menu/', 'nutrition', 'Nutrition', 'getSiteMenu', 'national'] });
// Panera
await get('panera-js', 'https://www.panerabread.com/content/dam/panerabread/static/www-ui/2.97.1-3ed67cfe/js/www-ui.min.js', { save: false, ctx: 250, grep: ['/menu', 'nutrition', 'Nutrition', 'public/'] });
await writeFile('probe/report3.json', JSON.stringify(report, null, 1));
