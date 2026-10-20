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
  // A few retries: some PDF hosts drop the occasional connection.
  let res, err;
  for (let attempt = 0; attempt < 4 && !res; attempt++) {
    try {
      res = await fetch(url, { headers: { ...HEADERS, Accept: 'application/pdf,*/*', 'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"' } });
    } catch (e) { err = e; await new Promise(r => setTimeout(r, 3000 * (attempt + 1))); }
  }
  if (!res) throw new Error(`${err.message} (${err.cause && (err.cause.code || err.cause.message)}) for ${url}`);
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

/* ---------------- McDonald's: nutrition calculator data ---------------- */
// Some sites only answer requests that look like a full browser visit.
const CLIENT_HINTS = { 'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"' };
const BROWSER = {
  ...CLIENT_HINTS, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function mcdonalds() {
  const calc = 'https://www.mcdonalds.com/us/en-us/about-our-food/nutrition-calculator.html';
  const page = await fetchText(calc, BROWSER);
  const m = page.match(/data-product-data='([^']*)'/);
  if (!m) throw new Error('product list not found on calculator page');
  const data = JSON.parse(m[1].replace(/&#34;/g, '"').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'"));
  const ids = new Set();
  for (const [id, prod] of Object.entries(data.products || {})) {
    ids.add(id);
    for (const sz of prod.sizes || []) if (sz.itemId) ids.add(sz.itemId);
  }
  const items = [];
  let lastErr = '';
  for (const id of ids) {
    try {
      const j = JSON.parse(await fetchText(`https://www.mcdonalds.com/dnaapp/itemDetails?country=US&language=en&showLiveData=true&item=${id}`,
        { ...CLIENT_HINTS, Accept: 'application/json, text/plain, */*', Referer: calc }));
      const it = j.item;
      const nut = {};
      for (const n of (it.nutrient_facts && it.nutrient_facts.nutrient) || []) nut[n.nutrient_name_id] = num(n.value);
      const serving = typeof it.serving_size_imperial === 'string' ? it.serving_size_imperial : '';
      items.push({ name: clean(it.item_name || it.item_marketing_name), serving, cal: nut.calories, f: nut.fat, c: nut.carbohydrate, p: nut.protein });
    } catch (e) { lastErr = e.message; /* skip one bad item */ }
    await sleep(120); // be polite
  }
  if (!items.length) throw new Error(`no item details loaded (${ids.size} ids; last error: ${lastErr})`);
  return items;
}

/* ---------------- Five Guys: official Nutrition & Allergen Guide PDF ---------------- */
// The guide lists parts (patty, bun, cheese, bacon, shake base, mix-ins), not finished items,
// so the menu is built from them the way Five Guys builds it (a burger is two patties).
export function parseFiveGuys(text) {
  const body = text.split(/INGREDIENT LISTING/)[0];
  const parts = {}, out = [];
  let section = '', seenMix = 0;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (/^[A-Z][A-Z &\-()0-9%]+$/.test(line) || /^MIX-INS/.test(line)) {
      section = line.replace(/\s*\(.*$/, '').replace(/ - .*$/, '');
      if (section === 'MIX-INS' && seenMix++) section = 'MIX-INS#2';
      continue;
    }
    // name, serving (g), calories, calories from fat, fat, sat, trans, cholesterol, sodium, carbs, fiber, sugars, protein
    const m = line.match(/^(.+?)\s{2,}(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/);
    if (!m || num(m[3]) == null) continue;
    const name = clean(m[1]).replace(/\s*\(Supplier \w+\)/i, '');
    const item = { name, serving: num(m[2]) != null ? `${num(m[2])} g` : '', cal: num(m[3]), f: num(m[5]), c: num(m[10]), p: num(m[13]) };
    const key = `${section}|${name}`;
    if (parts[key]) continue; // same part from a second supplier
    parts[key] = item;
    if (/^(MEAT|BUN)$/.test(section)) continue; // parts of sandwiches, not ordered alone
    if (/MILKSHAKES|MIX-INS/.test(section)) continue; // shakes are built below
    const label = section === 'TOPPINGS' ? `${name} (topping)` : section === 'FRIES' ? `${name} Fries` : name;
    out.push({ ...item, name: label.replace(/Five Guys Style Fries/, 'Fries') });
  }
  const get = (sec, n) => parts[`${sec}|${n}`];
  const sum = (name, list) => {
    if (list.some(x => !x)) return;
    const t = { cal: 0, f: 0, c: 0, p: 0 };
    for (const x of list) for (const k in t) t[k] += x[k] || 0;
    out.push({ name, serving: 'built from Five Guys parts', ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v * 10) / 10])) });
  };
  const patty = get('MEAT', 'Hamburger Patty'), bun = get('BUN', 'Hamburger Bun'), cheese = get('TOPPINGS', 'Cheese (1 slice)');
  const bacon = get('MEAT', 'Bacon (2 pieces)'), dog = get('MEAT', 'Hot Dog'), dogBun = get('BUN', 'Hot Dog Buns');
  for (const [size, n] of [['', 2], ['Little ', 1]]) {
    const pats = Array(n).fill(patty), chz = Array(n).fill(cheese);
    sum(`${size}Hamburger`, [...pats, bun]);
    sum(`${size}Cheeseburger`, [...pats, ...chz, bun]);
    sum(`${size}Bacon Burger`, [...pats, bacon, bun]);
    sum(`${size}Bacon Cheeseburger`, [...pats, ...chz, bacon, bun]);
    sum(`${size}Hamburger (lettuce wrap, no bun)`, pats);
    sum(`${size}Cheeseburger (lettuce wrap, no bun)`, [...pats, ...chz]);
  }
  sum('Hot Dog', [dog, dogBun]);
  sum('Cheese Dog', [dog, cheese, dogBun]);
  sum('Bacon Dog', [dog, bacon, dogBun]);
  sum('Bacon Cheese Dog', [dog, cheese, bacon, dogBun]);
  // Shakes: base + whipped cream, plus one mix-in. Mini shakes use the second set of parts.
  for (const [label, base, mix] of [['', 'Vanilla Shake Base', 'MIX-INS'], ['Mini ', 'Mini Vanilla Shake Base', 'MIX-INS#2']]) {
    const b = get(label ? 'MINI MILKSHAKES' : 'MILKSHAKES', base), w = get(label ? 'MINI MILKSHAKES' : 'MILKSHAKES', 'Whipped Cream');
    sum(`${label}Vanilla Milkshake`, [b, w]);
    for (const [k, v] of Object.entries(parts)) if (k.startsWith(mix + '|')) {
      const flavor = v.name.replace(/\s*\(.*\)/, '').replace(/ (Sauce|Marinade)$/, '');
      sum(`${label}${flavor} Milkshake`, [b, w, v]);
    }
  }
  return out;
}
async function fiveguys() {
  const page = await fetchText('https://www.fiveguys.com/nutritional-allergy-information/');
  const pdf = (page.match(/https:\/\/www\.fiveguys\.com\/wp-content\/uploads\/[^"'\s]+US-Nutrition[^"'\s]*English[^"'\s]*\.pdf/i) || [])[0];
  if (!pdf) throw new Error('Nutrition guide PDF link not found');
  return parseFiveGuys(await pdfText(pdf));
}

/* ---------------- Subway: official U.S. Nutrition Information PDF ---------------- */
async function subway() {
  // Find the current PDF link on the nutrition page; if that page won't load, use the last known link.
  let pdf = 'https://media.subway.com/dam/urn:aaid:aem:f20a4541-8c88-496b-940d-4aa8318cae26/original/as/us-nutrition-en.pdf';
  try {
    const page = await fetchText('https://www.subway.com/en-us/menunutrition/nutrition', BROWSER);
    pdf = (page.match(/https:\/\/media\.subway\.com\/[^"'\s]+us-nutrition-en\.pdf/i) || [])[0] || pdf;
  } catch { /* fall back to the known link */ }
  const text = await pdfText(pdf);
  const isNum = t => /^<?\d+(\.\d+)?$/.test(t);
  // Sections print each item again as a wrap, salad, bowl or pocket; tag the name so they stay distinct.
  const SUFFIX = { WRAPS: ' Wrap', SALADS: ' Salad', 'PROTEIN BOWLS': ' Protein Bowl' };
  let suffix = '';
  const items = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^[A-Z][A-Z &]{3,}$/.test(line)) { suffix = SUFFIX[line] || ''; continue; }
    if (/^Protein Pockets/.test(line)) { suffix = ' Protein Pocket'; continue; }
    const toks = line.split(/\s+/);
    const i = toks.findIndex((t, j) => j > 0 && toks.slice(j, j + 12).length === 12 && toks.slice(j, j + 12).every(isNum));
    if (i < 1) continue;
    let name = clean(toks.slice(0, i).filter(t => !/^\*+$/.test(t)).join(' ').replace(/\*+/g, ''));
    if (suffix && !/^\d+"/.test(name)) name += suffix;
    const v = toks.slice(i, i + 12).map(num);
    // Serving (g), Calories, Fat, Sat Fat, Trans Fat, Cholesterol, Sodium, Carbs, Fiber, Sugars, Added Sugars, Protein
    items.push({ name, serving: `${v[0]} g`, cal: v[1], f: v[2], c: v[7], p: v[11] });
  }
  return items;
}

/* ---------------- Wendy's: national menu from the ordering site's service ---------------- */
async function wendys() {
  // The service wants the ordering app's current version number; read it from the site, with a fallback.
  let version = '2.21.2';
  try {
    const page = await fetchText('https://order.wendys.com/us/en/national/menu?site=menu&lang=en_US', BROWSER);
    version = (page.match(/APP_PUBLIC_VERSION(?:\\?"|&quot;)\s*:\s*(?:\\?"|&quot;)([\d.]+)/) || [])[1] || version;
  } catch { /* use fallback */ }
  const url = 'https://api.app.prd.wendys.digital/web-client-gateway/menu/getSiteMenu?siteNum=0&freeStyleMenu=true&menuChannel=WEB_GUEST' +
    `&lang=en&cntry=US&sourceCode=ORDER.WENDYS&version=${version}`;
  const data = JSON.parse(await fetchText(url, { Accept: 'application/json', Origin: 'https://order.wendys.com', Referer: 'https://order.wendys.com/' }));
  return (data.menuLists.salesItems || []).filter(i => i.nutrition && i.nutrition.calories != null).map(i => {
    const n = i.nutrition;
    let name = clean(i.displayName || String(i.name).replace(/\s+MRI$/, ''));
    let size = clean(i.shortDescription || '');
    if (/^[A-Z .]+$/.test(size)) size = size.charAt(0) + size.slice(1).toLowerCase();   // "SMALL" -> "Small"
    if (/^junior$/i.test(size) && /\bjr\b/i.test(name)) size = '';
    if (size && !name.toLowerCase().includes(size.toLowerCase())) name = `${size} ${name}`;
    // Wendy's doesn't publish carbs in this data, so estimate them from calories, protein and fat.
    const c = Math.max(0, Math.round((n.calories - 4 * n.protein - 9 * n.totalFat) / 4));
    return { name, serving: '', cal: n.calories, f: n.totalFat, c, p: n.protein, carbsEstimated: true };
  });
}

const CHAINS = {
  chickfila: { name: 'Chick-fil-A', aliases: ['chickfila', 'chick fil a', 'cfa'], source: 'https://www.chick-fil-a.com/nutrition-allergens', run: chickfila },
  dunkin:    { name: "Dunkin'", aliases: ['dunkin', 'dunkin donuts', 'dd'], source: 'https://www.dunkindonuts.com/en/menu/nutrition', run: dunkin },
  mcdonalds: { name: "McDonald's", aliases: ['mcdonalds', 'mcd', 'mickey ds'], source: 'https://www.mcdonalds.com/us/en-us/about-our-food/nutrition-calculator.html', run: mcdonalds },
  subway:    { name: 'Subway', aliases: ['subway'], source: 'https://www.subway.com/en-us/menunutrition/nutrition', run: subway },
  fiveguys:  { name: 'Five Guys', aliases: ['five guys', '5 guys', 'fiveguys'], source: 'https://www.fiveguys.com/nutritional-allergy-information/', run: fiveguys },
  wendys:    { name: "Wendy's", aliases: ['wendys', 'wendy'], source: 'https://order.wendys.com/us/en/national/menu', run: wendys },
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
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
