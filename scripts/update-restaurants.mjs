// Pulls official nutrition info for restaurant chains into restaurants.json (used by the
// app's food autocomplete). Run weekly by .github/workflows/restaurants.yml. Node 20+.
// Each chain is independent: if one site changes or blocks us, the others still update and
// that chain keeps its last good data.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = new URL('../restaurants.json', import.meta.url);
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/json,application/pdf,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9',
};
async function fetchText(url, headers = {}) {
  const res = await fetch(url, { headers: { ...HEADERS, ...headers }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.text();
}
async function pdfText(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const file = join(tmpdir(), `nutrition-${Date.now()}.pdf`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return execFileSync('pdftotext', ['-layout', file, '-'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
}
const num = t => { const n = parseFloat(String(t ?? '').replace(/[<,]/g, '')); return Number.isFinite(n) ? n : null; };
const clean = t => String(t).replace(/&amp;/g, '&').replace(/&#0?39;|&#8217;|’/g, "'").replace(/&#8211;|–/g, '-').replace(/&quot;/g, '"')
  .replace(/&reg;|®|&trade;|™/g, '').replace(/\s+/g, ' ').trim();

/* ---------------- Chick-fil-A: nutrition table on chick-fil-a.com ---------------- */
async function chickfila() {
  const html = await fetchText('https://www.chick-fil-a.com/nutrition-allergens');
  // Rows: an item/sub-item title followed by its cells in this order:
  // [template], Serving, Calories, Fat, Sat Fat, Trans Fat, Cholesterol, Sodium, Carbs, Fiber, Sugar, Protein
  const re = /data-wp-text="context\.([a-z_]+\.title|[a-z_]+_data\.value)"[^>]*>([^<]*)</g;
  const rows = []; let cur = null, m;
  while ((m = re.exec(html))) {
    const [, kind, raw] = m, text = clean(raw);
    if (kind.endsWith('.title')) {
      if (!text) continue;
      if (!cur || cur.name !== text || cur.vals.length) { cur = { name: text, vals: [] }; rows.push(cur); }
    } else if (cur) cur.vals.push(text);
  }
  return rows.filter(r => r.vals.length >= 12).map(r => ({
    name: r.name, serving: r.vals[1], cal: num(r.vals[2]), f: num(r.vals[3]), c: num(r.vals[8]), p: num(r.vals[11]),
  }));
}

/* ---------------- Dunkin': official Nutrition Guide PDF ---------------- */
async function dunkin() {
  const page = await fetchText('https://www.dunkindonuts.com/en/menu/nutrition');
  const pdf = (page.match(/\/\/[^"'\s]+?nutrition_guide[^"'\s]*?\.pdf/i) || [])[0];
  if (!pdf) throw new Error('Nutrition Guide PDF link not found');
  const lines = (await pdfText('https:' + pdf)).split('\n');
  // Row: Name | Serving | Calories, Fat, Sat Fat, Trans Fat, Cholesterol, Sodium, Carbs, Fiber, Sugars, Added Sugars, Protein, ...
  const isNum = t => /^<?\d+(\.\d+)?$/.test(t);
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const toks = lines[i].trim().split(/\s{2,}/);
    const k = toks.findIndex((t, j) => j > 0 && toks.slice(j, j + 11).length === 11 && toks.slice(j, j + 11).every(isNum));
    if (k < 1) continue;
    let name = toks.slice(0, Math.max(1, k - 1)).join(' ');
    const serving = k >= 2 ? toks[k - 1] : '';
    const v = toks.slice(k, k + 11).map(num);
    // Long names wrap onto the next line ("Bacon, Egg and Cheese on" + "Croissant").
    const next = (lines[i + 1] || '').trim();
    if (next && !/\s{2,}/.test(next) && !isNum(next) && next.length < 45 &&
        (/(?:[-,&(]|\b(?:and|on|with|of|w\/|a|the|in|Wake-Up|Iced|Hot|Frozen|English))$/i.test(name) || /^[a-z(]/.test(next))) name = `${name} ${next}`;
    items.push({ name: clean(name), serving, cal: v[0], f: v[1], c: v[6], p: v[10] });
  }
  return items;
}

const CHAINS = {
  chickfila: { name: 'Chick-fil-A', aliases: ['chickfila', 'chick fil a', 'cfa'], source: 'https://www.chick-fil-a.com/nutrition-allergens', run: chickfila },
  dunkin:    { name: "Dunkin'", aliases: ['dunkin', 'dunkin donuts', 'dd'], source: 'https://www.dunkindonuts.com/en/menu/nutrition', run: dunkin },
};

async function main() {
  let old = { chains: {} };
  try { old = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* first run */ }
  const out = { updated: new Date().toISOString().slice(0, 10), chains: { ...old.chains }, status: {} };
  for (const [id, ch] of Object.entries(CHAINS)) {
    try {
      const seen = new Set();
      const items = (await ch.run()).filter(i => i.name && (i.cal != null || i.p != null))
        .filter(i => { const k = i.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
      if (items.length < 10) throw new Error(`only ${items.length} items parsed`);
      out.chains[id] = { name: ch.name, aliases: ch.aliases, source: ch.source, updated: out.updated, items };
      out.status[id] = `ok: ${items.length} items`;
    } catch (e) {
      out.status[id] = `FAILED (kept previous data): ${e.message}`;
    }
    console.log(ch.name.padEnd(12), out.status[id]);
  }
  await writeFile(OUT, JSON.stringify(out, null, 1) + '\n');
}
main().catch(e => { console.error(e); process.exit(1); });
