// Scout: IHOP nutrition sources (public pages only).
import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
await mkdir('probe/ihop', { recursive: true });
const H = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'gzip, deflate, br',
  'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"',
  'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1',
};
const report = [];
let n = 0;
async function get(url) {
  const r = { url };
  try {
    const res = await fetch(url, { headers: H, redirect: 'follow' });
    r.status = res.status; r.finalUrl = res.url; r.type = res.headers.get('content-type');
    const buf = Buffer.from(await res.arrayBuffer()); r.bytes = buf.length;
    const file = `probe/ihop/${n++}`;
    if ((r.type || '').includes('pdf')) {
      await writeFile(file + '.pdf', buf);
      try { execFileSync('pdftotext', ['-layout', file + '.pdf', file + '.txt']); r.saved = file + '.txt'; } catch (e) { r.pdfErr = e.message; }
    } else {
      const text = buf.toString('utf8');
      await writeFile(file + '.html', text.slice(0, 2_500_000)); r.saved = file + '.html';
      r.links = [...new Set(text.match(/(?:https?:)?\/\/[^"'\s<>()\\]+|\/[A-Za-z0-9_\-./]+\.(?:pdf|json)[^"'\s<>]*/g) || [])]
        .filter(l => /pdf|json|api|nutri|calc|menu|\.js(\?|$)/i.test(l)).slice(0, 250);
    }
  } catch (e) { r.error = e.message; r.cause = e.cause && (e.cause.code || e.cause.message); }
  report.push(r); console.log(url, r.status || r.error, r.bytes || '');
  return r;
}
for (const u of ['https://www.ihop.com/en/nutrition', 'https://www.ihop.com/en/menu', 'https://www.ihop.com/en/nutrition-calculator',
  'https://www.ihop.com/-/media/ihop/files/ihop-nutrition-faq.pdf']) await get(u);
// Follow nutrition-looking PDF links found on those pages
const pdfs = [...new Set(report.flatMap(r => r.links || []).filter(l => /\.pdf/i.test(l) && /nutri|allerg|calor/i.test(l)))].slice(0, 4);
for (const l of pdfs) await get(l.startsWith('//') ? 'https:' + l : new URL(l, 'https://www.ihop.com').href);
await writeFile('probe/report-ihop.json', JSON.stringify(report, null, 1));
