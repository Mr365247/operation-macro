#!/usr/bin/env python3
"""Adds Tropical Smoothie Cafe to restaurants.json from its nutrition-guide PDF.

Their site blocks automated downloads, so this runs by hand whenever a new guide comes out:
    pip install pypdf
    python3 scripts/import-tropical-smoothie.py data/tropical-smoothie-nutrition-guide.pdf
The weekly restaurants workflow keeps chains it doesn't fetch itself, so this data stays put.
"""
import json, re, sys
from datetime import date
from pathlib import Path
from pypdf import PdfReader

OUT = Path(__file__).resolve().parent.parent / 'restaurants.json'
# Smoothie page: Cal, Cal w/ Splenda, Cal from fat, Fat, Sat, Trans, Chol, Sodium, Carbs,
# Carbs w/ Splenda, Fiber, Sugars, Sugars w/ Splenda, Protein, Caffeine.
SMOOTHIE_COLS = 15
# Food page: Cal, Cal from fat, Fat, Sat, Trans, Chol, Sodium, Carbs, Fiber, Sugars, Protein.
FOOD_COLS = 11
SECTIONS = {
    'SMOOTHIES': '24 oz smoothie', 'KIDS SMOOTHIES (12 OZ.)': '12 oz kids smoothie',
    'SUPPLEMENTS': 'smoothie add-in', 'FRESH ADD-INS': 'smoothie add-in', 'BOTTLED BEVERAGES': 'bottle',
    'TROPIC BOWLS': 'bowl', 'BREAKFAST': 'breakfast', 'WRAPS & BOWLS': 'wrap/bowl', 'SANDWICHES': 'sandwich',
    'FLATBREADS': 'flatbread', "'DILLAS": 'quesadilla', 'TOASTED SNACK ROLLS': 'snack roll',
    'KIDS FOOD ITEMS': 'kids meal', 'SIDES': 'side', 'COOKIES': 'cookie',
}
NUM = re.compile(r'^(N/A|\d*\.?\d+)$')

def val(t):
    return None if t == 'N/A' else float(t) if '.' in t else int(t)

def clean(name):
    name = name.replace('’', "'").replace('‘', "'").replace('®', '').replace('™', '')
    return re.sub(r'\s+', ' ', name).strip()

def parse(text):
    items, section = [], None
    for raw in text.splitlines():
        line = raw.strip()
        head = clean(line).upper()
        if head in SECTIONS:
            section = head
            continue
        if not section:
            continue
        toks = line.split()
        n = 0
        while n < len(toks) and NUM.match(toks[-1 - n]):
            n += 1
        smoothie = section in ('SMOOTHIES', 'KIDS SMOOTHIES (12 OZ.)', 'SUPPLEMENTS', 'FRESH ADD-INS', 'BOTTLED BEVERAGES')
        cols = SMOOTHIE_COLS if smoothie else FOOD_COLS
        if n < cols:
            if n == 0:  # legend/footer text ends the section
                section = None if line.startswith(('Gluten', 'Total', '1.')) else section
            continue
        name = clean(' '.join(toks[:len(toks) - n]))
        v = [val(t) for t in toks[len(toks) - cols:]]
        serving = SECTIONS[section]
        if smoothie:
            cal, cal_s, fat, carbs, carbs_s, protein = v[0], v[1], v[3], v[8], v[9], v[13]
            label = name if section != 'SMOOTHIES' or 'smoothie' in name.lower() else f'{name} Smoothie'
            items.append(dict(name=label, serving=serving, cal=cal, f=fat, c=carbs, p=protein))
            if section in ('SMOOTHIES', 'KIDS SMOOTHIES (12 OZ.)') and cal_s is not None and cal_s != cal:
                items.append(dict(name=f'{label} with Splenda', serving=serving, cal=cal_s, f=fat, c=carbs_s, p=protein))
        else:
            if section == 'COOKIES':
                name += ' Cookie'
            if 'Drizzle' in name:
                serving = 'bowl topping'
            items.append(dict(name=name, serving=serving, cal=v[0], f=v[2], c=v[7], p=v[10]))
    return items

# Limited-time items are laid out differently in the guide, so they're entered by hand.
SEASONAL = [
    dict(name='Salted Caramel Javablender (limited time)', serving='24 oz', cal=490, f=12, c=89, p=7),
    dict(name='Fanta Phantom Smoothie (limited time)', serving='24 oz', cal=370, f=0.5, c=93, p=4),
    dict(name='Fanta Phantom Smoothie (limited time) no turbinado', serving='24 oz', cal=260, f=0.5, c=64, p=4),
]

def main():
    pdf = sys.argv[1]
    text = '\n'.join(p.extract_text() for p in PdfReader(pdf).pages)
    guide = re.search(r'\b(\d{2}/\d{2}/\d{2})\b', text)
    items = parse(text) + SEASONAL
    if len(items) < 80:
        sys.exit(f'only parsed {len(items)} items; the guide layout may have changed')
    data = json.loads(OUT.read_text())
    data['chains']['tropicalsmoothie'] = {
        'name': 'Tropical Smoothie Cafe', 'aliases': ['tropical smoothie', 'tsc', 'tropical'],
        'source': 'Nutrition guide PDF' + (f' dated {guide.group(1)}' if guide else '') + ' (data/tropical-smoothie-nutrition-guide.pdf)',
        'updated': date.today().isoformat(), 'items': items,
    }
    data.setdefault('status', {})['tropicalsmoothie'] = f'ok: {len(items)} items (manual import)'
    OUT.write_text(json.dumps(data, indent=1, ensure_ascii=False) + '\n')
    print(f'Tropical Smoothie Cafe: {len(items)} items')

if __name__ == '__main__':
    main()
