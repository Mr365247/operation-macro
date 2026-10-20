// One-time check: where does each chain publish its nutrition info? Writes probe/results.md.
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' };
const PAGES2 = {
  'Five Guys': ['https://www.fiveguys.com/nutritional-allergy-information/'],
  'Chipotle': ['https://www.chipotle.com/nutrition-calculator'],
};
const PAGES0 = {
  'Five Guys': ['https://www.fiveguys.com/nutrition', 'https://www.fiveguys.com/menu', 'https://www.fiveguys.com/'],
  'Burger King': ['https://www.bk.com/nutrition-explorer', 'https://www.bk.com/menu', 'https://www.bk.com/'],
  "Raising Cane's": ['https://www.raisingcanes.com/nutrition', 'https://www.raisingcanes.com/menu', 'https://www.raisingcanes.com/'],
  'Chipotle': ['https://www.chipotle.com/nutrition-calculator', 'https://www.chipotle.com/'],
  "Baja's": ['https://www.bajasrestaurants.com/', 'https://bajasrestaurants.com/menu'],
};
const PAGES = { 'Five Guys': ['https://www.fiveguys.com/nutritional-allergy-information/'] };
let md = `# Chain probe ${new Date().toISOString()}\n`;
const pdfs = new Set();
for (const [chain, urls] of Object.entries(PAGES)) {
  md += `\n## ${chain}\n`;
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: UA, redirect: 'follow' });
      const html = await res.text();
      const title = (html.match(/<title[^>]*>([^<]*)/i) || [])[1] || '';
      md += `- ${url} → ${res.status} ${res.url} (${html.length} bytes) "${title.trim().slice(0, 80)}"\n`;
      const links = new Set();
      for (const m of html.matchAll(/(?:href|src|"url"|"link")\s*[:=]\s*["']([^"']+)["']/gi)) {
        const u = m[1];
        if (/\.pdf|nutrition|allergen|nutri/i.test(u)) { try { links.add(new URL(u, res.url).href); } catch {} }
      }
      for (const m of html.matchAll(/https?:\/\/[^"'\s)\\]+\.pdf/gi)) links.add(m[0]);
      for (const l of [...links].slice(0, 25)) { md += `  - ${l}\n`; if (/\.pdf(\?|$)/i.test(l)) pdfs.add(chain + '|' + l); }
      const kw = ['calories', 'Calories', 'protein', 'Protein', '__NEXT_DATA__', 'carbohydrate', 'Total Fat', 'Chicken', 'Barbacoa', 'application/ld+json'];
      md += '  - counts: ' + kw.map(k => `${k}=${html.split(k).length - 1}`).join(' ') + '\n';
      const i = html.search(/[Cc]alories/);
      if (i > 0) md += '  - snippet: `' + html.slice(Math.max(0, i - 300), i + 300).replace(/\s+/g, ' ').replace(/`/g, "'") + '`\n';
      if (/cf-chl|captcha|Access Denied|Incapsula|akamai/i.test(html.slice(0, 5000))) md += `  - ⚠️ looks like bot protection\n`;
    } catch (e) { md += `- ${url} → ERROR ${e.message}\n`; }
  }
}
md += `\n## PDFs\n`;
for (const item of pdfs) {
  const [chain, url] = item.split('|');
  try {
    const res = await fetch(url, { headers: UA });
    const buf = Buffer.from(await res.arrayBuffer());
    md += `- ${chain}: ${url} → ${res.status} ${res.headers.get('content-type')} ${buf.length} bytes\n`;
    if (res.ok && buf.slice(0, 4).toString() === '%PDF') {
      writeFileSync('/tmp/p.pdf', buf);
      const text = execFileSync('pdftotext', ['-layout', '/tmp/p.pdf', '-']).toString();
      writeFileSync('probe/fiveguys.txt', text);
    }
  } catch (e) { md += `- ${chain}: ${url} → ERROR ${e.message}\n`; }
}
writeFileSync('probe/results.md', md);
console.log(md);
