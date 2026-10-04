// One-off scout: fetch each chain's official nutrition pages and record what's there.
import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'Accept': 'text/html,application/json,application/pdf,*/*', 'Accept-Language': 'en-US,en;q=0.9' };
const CHAINS = {
  chickfila: ['https://www.chick-fil-a.com/nutrition-allergens', 'https://www.chick-fil-a.com/menu'],
  chipotle: ['https://www.chipotle.com/nutrition-calculator', 'https://www.chipotle.com/allergens'],
  wendys: ['https://www.wendys.com/nutrition-info', 'https://www.wendys.com/menu', 'https://digitalservices.prod.ext-aws.wendys.com/menu/getSiteMenu?lang=en&cntry=US&sourceCode=ORDER.WENDYS&version=22.1.2&siteNum=0'],
  mcdonalds: ['https://www.mcdonalds.com/us/en-us/about-our-food/nutrition-calculator.html', 'https://www.mcdonalds.com/us/en-us/full-menu.html', 'https://www.mcdonalds.com/dnaapp/itemList?country=US&language=en'],
  subway: ['https://www.subway.com/en-us/menunutrition/nutrition', 'https://www.subway.com/en-us/menunutrition/menu/all'],
  dunkin: ['https://www.dunkindonuts.com/en/menu/nutrition', 'https://www.dunkindonuts.com/en/menu'],
  panera: ['https://www.panerabread.com/en-us/menu/nutrition.html', 'https://www.panerabread.com/en-us/menu.html'],
};
await mkdir('probe/out', { recursive: true });
const report = {};
const linkRe = /(https?:)?\/\/[^"'\s<>()]+|\/[A-Za-z0-9_\-./]+\.(?:pdf|json)[^"'\s<>]*/g;
for (const [chain, urls] of Object.entries(CHAINS)) {
  report[chain] = [];
  let n = 0;
  for (const url of urls) {
    const r = { url };
    try {
      const res = await fetch(url, { headers: UA, redirect: 'follow' });
      r.status = res.status; r.finalUrl = res.url; r.type = res.headers.get('content-type');
      const buf = Buffer.from(await res.arrayBuffer());
      r.bytes = buf.length;
      const file = `probe/out/${chain}-${n++}`;
      if ((r.type || '').includes('pdf')) {
        await writeFile(file + '.pdf', buf);
        try { execFileSync('pdftotext', ['-layout', file + '.pdf', file + '.txt']); r.saved = file + '.txt'; } catch (e) { r.pdfErr = e.message; }
      } else {
        const text = buf.toString('utf8');
        await writeFile(file + ((r.type || '').includes('json') ? '.json' : '.html'), text.slice(0, 3_000_000));
        r.hasNextData = text.includes('__NEXT_DATA__'); r.jsonLd = (text.match(/application\/ld\+json/g) || []).length;
        const links = [...new Set((text.match(linkRe) || []).filter(l => /pdf|json|api|nutrition|menu|graphql|\.js(\?|$)/i.test(l)))];
        r.links = links.slice(0, 300);
      }
    } catch (e) { r.error = e.message; }
    report[chain].push(r);
    console.log(chain, url, r.status || r.error, r.bytes || '');
  }
}
// Follow PDF links that look like nutrition guides (first 2 per chain).
for (const [chain, rows] of Object.entries(report)) {
  const pdfs = [...new Set(rows.flatMap(r => r.links || []).filter(l => /\.pdf/i.test(l) && /nutri|allerg/i.test(l)))].slice(0, 2);
  let n = 0;
  for (let l of pdfs) {
    const base = rows[0].finalUrl || rows[0].url;
    const url = l.startsWith('//') ? 'https:' + l : new URL(l, base).href;
    const r = { url, followed: true };
    try {
      const res = await fetch(url, { headers: UA });
      r.status = res.status; r.type = res.headers.get('content-type');
      const buf = Buffer.from(await res.arrayBuffer()); r.bytes = buf.length;
      const file = `probe/out/${chain}-pdf${n++}`;
      await writeFile(file + '.pdf', buf);
      try { execFileSync('pdftotext', ['-layout', file + '.pdf', file + '.txt']); r.saved = file + '.txt'; } catch (e) { r.pdfErr = e.message; }
    } catch (e) { r.error = e.message; }
    rows.push(r);
  }
}
await writeFile('probe/report.json', JSON.stringify(report, null, 1));
