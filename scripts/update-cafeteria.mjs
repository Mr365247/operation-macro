// Downloads the North Providence High School menu (with nutrition) from Nutrislice
// and merges every item into cafeteria.json, which the app uses for autocomplete.
// Run by .github/workflows/cafeteria.yml every week. Node 20+ (built-in fetch).
import { readFile, writeFile } from 'node:fs/promises';

const DISTRICT = 'npsd';
const SCHOOL = 'north-providence-high';
const API = `https://${DISTRICT}.api.nutrislice.com/menu/api`;
const OUT = new URL('../cafeteria.json', import.meta.url);

async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'operation-macro-menu-sync' } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

async function menuTypes() {
  try {
    const schools = await getJSON(`${API}/schools/?format=json`);
    const list = Array.isArray(schools) ? schools : schools.results || [];
    const school = list.find(s => s.slug === SCHOOL);
    const types = (school && (school.active_menu_types || school.menu_types)) || [];
    const slugs = types.map(t => ({ slug: t.slug, name: t.name || t.slug })).filter(t => t.slug);
    if (slugs.length) return slugs;
    console.log('School found but no menu types listed; using defaults.');
  } catch (e) { console.log('Could not read school list:', e.message); }
  return [{ slug: 'breakfast', name: 'Breakfast' }, { slug: 'lunch', name: 'Lunch' }];
}

const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
const r1 = v => v == null ? null : Math.round(v * 10) / 10;

async function main() {
  let old = { items: [] };
  try { old = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* first run */ }
  const byName = new Map(old.items.map(i => [i.name.toLowerCase(), i]));

  const types = await menuTypes();
  console.log('Menu types:', types.map(t => t.slug).join(', '));
  const start = new Date(); start.setDate(start.getDate() - 14);
  let fetched = 0, seen = 0;

  for (const type of types) {
    for (let w = 0; w < 6; w++) {
      const d = new Date(start); d.setDate(d.getDate() + w * 7);
      const path = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
      let week;
      try { week = await getJSON(`${API}/weeks/school/${SCHOOL}/menu-type/${type.slug}/${path}/?format=json`); fetched++; }
      catch (e) { console.log('Skip', type.slug, path, e.message); continue; }
      for (const day of week.days || []) {
        for (const mi of day.menu_items || []) {
          const food = mi.food;
          if (!food || !food.name) continue;
          const n = food.rounded_nutrition_info || food.nutrition_info || {};
          const item = {
            name: food.name.trim(),
            cal: r1(num(n.calories)), p: r1(num(n.g_protein)), c: r1(num(n.g_carbs)), f: r1(num(n.g_fat)),
            serving: food.serving_size_info
              ? [food.serving_size_info.serving_size_amount, food.serving_size_info.serving_size_unit].filter(Boolean).join(' ')
              : '',
            meal: type.name,
            lastServed: day.date || null,
          };
          seen++;
          const key = item.name.toLowerCase();
          const prev = byName.get(key);
          // Keep the newest nutrition we have; don't wipe numbers if a week came back without them.
          if (prev && item.cal == null && item.p == null) { prev.lastServed = item.lastServed || prev.lastServed; continue; }
          if (prev && prev.meal) item.meal = prev.meal.includes(item.meal) ? prev.meal : `${prev.meal}, ${item.meal}`;
          byName.set(key, { ...prev, ...item });
        }
      }
    }
  }
  if (!fetched) { console.error('No menu weeks could be fetched; leaving cafeteria.json unchanged.'); process.exit(1); }

  const items = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const out = { school: 'North Providence High School', source: `https://${DISTRICT}.nutrislice.com/menu/${SCHOOL}`, updated: new Date().toISOString().slice(0, 10), items };
  await writeFile(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(`Fetched ${fetched} menu weeks, ${seen} menu items; library now has ${items.length} foods (${items.filter(i => i.cal != null).length} with nutrition).`);
}
main().catch(e => { console.error(e); process.exit(1); });
