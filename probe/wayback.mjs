// One-time check: where does Wayback Burgers publish nutrition info?
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' };
let md = '# Wayback probe\n'; const pdfs = new Set();
for (const url of ['https://waybackburgers.com/nutritional-info/']) {
  try {
    const res = await fetch(url, { headers: UA, redirect: 'follow' }); const html = await res.text();
    md += `- ${url} → ${res.status} ${res.url} (${html.length} bytes) "${((html.match(/<title[^>]*>([^<]*)/i) || [])[1] || '').trim().slice(0, 80)}"\n`;
    const links = new Set();
    for (const m of html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) if (/\.pdf|nutrition|allergen|nutri/i.test(m[1])) { try { links.add(new URL(m[1], res.url).href); } catch {} }
    for (const m of html.matchAll(/https?:\/\/[^"'\s)\\]+\.pdf/gi)) links.add(m[0]);
    for (const l of [...links].slice(0, 30)) { md += `  - ${l}\n`; if (/\.pdf(\?|$)/i.test(l)) pdfs.add(l); }
    if (/cf-chl|captcha|Access Denied/i.test(html.slice(0, 5000))) md += '  - ⚠️ bot protection\n';
    md += '  - counts: ' + ['Calories', 'calories', 'Protein', 'Fat', '<table', 'iframe', '.pdf'].map(k => `${k}=${html.split(k).length - 1}`).join(' ') + '\n';
    for (const m of html.matchAll(/<iframe[^>]+src=["']([^"']+)/gi)) md += `  - iframe: ${m[1]}\n`;
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const at = text.search(/Calories/i); md += '  - text: `' + text.slice(Math.max(0, at - 400), at + 1500).replace(/`/g, "'") + '`\n';
  } catch (e) { md += `- ${url} → ERROR ${e.message}\n`; }
}
let i = 0;
for (const url of pdfs) {
  try {
    const res = await fetch(url, { headers: UA }); const buf = Buffer.from(await res.arrayBuffer());
    md += `\n## PDF ${url} → ${res.status} ${buf.length} bytes\n`;
    if (buf.slice(0, 4).toString() === '%PDF') { writeFileSync('/tmp/p.pdf', buf); const t = execFileSync('pdftotext', ['-layout', '/tmp/p.pdf', '-']).toString(); writeFileSync(`probe/wayback-${i++}.txt`, t); md += '```\n' + t.split('\n').slice(0, 25).join('\n') + '\n```\n'; }
  } catch (e) { md += `- ${url} ERROR ${e.message}\n`; }
}
writeFileSync('probe/wayback.md', md);
