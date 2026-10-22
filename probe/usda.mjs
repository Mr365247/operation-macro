// One-time check of USDA FoodData Central's barcode search with the public DEMO_KEY.
import { writeFileSync } from 'node:fs';
const out = {};
for (const upc of ['041196910759', '028400090896', '049000028911']) {
  const s = await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?query=${upc}&dataType=Branded&pageSize=3&api_key=DEMO_KEY`);
  const sj = await s.json().catch(() => null);
  out[upc] = { status: s.status, cors: s.headers.get('access-control-allow-origin'), search: sj && { totalHits: sj.totalHits, foods: (sj.foods || []).slice(0, 2) } };
  const id = sj && sj.foods && sj.foods[0] && sj.foods[0].fdcId;
  if (id) {
    const d = await fetch(`https://api.nal.usda.gov/fdc/v1/food/${id}?api_key=DEMO_KEY`);
    const dj = await d.json().catch(() => null);
    out[upc].detail = dj && { status: d.status, gtinUpc: dj.gtinUpc, description: dj.description, brandOwner: dj.brandOwner, servingSize: dj.servingSize, servingSizeUnit: dj.servingSizeUnit, householdServingFullText: dj.householdServingFullText, labelNutrients: dj.labelNutrients };
  }
}
writeFileSync('probe/usda.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out).slice(0, 3000));
