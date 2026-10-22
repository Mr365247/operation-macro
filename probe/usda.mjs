// Round 2: get real barcodes by name, then see which query form finds them by barcode.
import { writeFileSync } from 'node:fs';
const K = 'api_key=DEMO_KEY';
const out = { byName: {}, tries: [] };
for (const q of ['Fairlife core power chocolate', 'Doritos nacho cheese', 'Chobani greek yogurt vanilla']) {
  const r = await (await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(q)}&dataType=Branded&pageSize=2&${K}`)).json();
  out.byName[q] = (r.foods || []).map(f => ({ fdcId: f.fdcId, description: f.description, brandName: f.brandName, gtinUpc: f.gtinUpc, servingSize: f.servingSize, servingSizeUnit: f.servingSizeUnit, householdServingFullText: f.householdServingFullText, publishedDate: f.publishedDate,
    nutrients: (f.foodNutrients || []).filter(n => [1003, 1004, 1005, 1008].includes(n.nutrientId)).map(n => [n.nutrientId, n.nutrientName, n.value, n.unitName]) }));
}
const sample = Object.values(out.byName).flat().find(f => f.gtinUpc);
if (sample) {
  const g = sample.gtinUpc, short = g.replace(/^0+/, '');
  for (const q of [g, short, `gtinUpc:${g}`, `gtinUpc:"${g}"`, `"${g}"`]) {
    const r = await (await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(q)}&dataType=Branded&pageSize=3&${K}`)).json();
    out.tries.push({ q, totalHits: r.totalHits, first: (r.foods || []).slice(0, 2).map(f => [f.fdcId, f.gtinUpc, f.description]) });
  }
  const d = await (await fetch(`https://api.nal.usda.gov/fdc/v1/food/${sample.fdcId}?${K}`)).json();
  out.detail = { gtinUpc: d.gtinUpc, servingSize: d.servingSize, servingSizeUnit: d.servingSizeUnit, householdServingFullText: d.householdServingFullText, labelNutrients: d.labelNutrients };
}
writeFileSync('probe/usda.json', JSON.stringify(out, null, 1));
