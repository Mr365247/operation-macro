// Round 3: same as round 2 but never crashes; records HTTP status and errors.
import { writeFileSync } from 'node:fs';
const K = 'api_key=wGJnfbGNwhdrtfMKLhbdDkgNJkNN8WfMLdbCkdPf';
const get = async url => { try { const r = await fetch(url); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, j, t: j ? '' : t.slice(0, 300) }; } catch (e) { return { status: 0, j: null, t: String(e) }; } };
const out = { byName: {}, tries: [] };
try {
  for (const q of ['Fairlife core power chocolate']) {
    const r = await get(`https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(q)}&dataType=Branded&pageSize=2&${K}`);
    out.byName[q] = { status: r.status, err: r.t, foods: ((r.j && r.j.foods) || []).map(f => ({ fdcId: f.fdcId, description: f.description, brandName: f.brandName, gtinUpc: f.gtinUpc, servingSize: f.servingSize, servingSizeUnit: f.servingSizeUnit, householdServingFullText: f.householdServingFullText, publishedDate: f.publishedDate,
      nutrients: (f.foodNutrients || []).filter(n => [1003, 1004, 1005, 1008].includes(n.nutrientId)).map(n => [n.nutrientId, n.nutrientName, n.value, n.unitName]) })) };
  }
  const sample = Object.values(out.byName).flatMap(x => x.foods).find(f => f.gtinUpc);
  if (sample) {
    const g = sample.gtinUpc, short = g.replace(/^0+/, '');
    for (const q of [g, short, `gtinUpc:${g}`, `"${g}"`]) {
      const r = await get(`https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(q)}&dataType=Branded&pageSize=3&${K}`);
      out.tries.push({ q, status: r.status, totalHits: r.j && r.j.totalHits, first: ((r.j && r.j.foods) || []).slice(0, 2).map(f => [f.fdcId, f.gtinUpc, f.description]), err: r.t });
    }
    const d = await get(`https://api.nal.usda.gov/fdc/v1/food/${sample.fdcId}?${K}`);
    out.detail = d.j ? { status: d.status, gtinUpc: d.j.gtinUpc, servingSize: d.j.servingSize, servingSizeUnit: d.j.servingSizeUnit, householdServingFullText: d.j.householdServingFullText, labelNutrients: d.j.labelNutrients } : { status: d.status, err: d.t };
  }
} catch (e) { out.crash = String(e.stack || e); }
writeFileSync('probe/usda.json', JSON.stringify(out, null, 1));
