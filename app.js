'use strict';

/* ================= Data ================= */

const STORE_KEY = 'opmacro_v1';
const DEFAULT_SETTINGS = { cal: 2200, protein: 225, carbs: 65, fat: 70, weight: 250, goalWeight: 225 };
// Ring order on the home screen. k = key on an entry, t = key in settings.
const MACROS = [
  { k: 'cal', t: 'cal',     label: 'Calories', short: 'Cal',  unit: '',  cls: 'cal',  color: 'var(--cal)' },
  { k: 'p',   t: 'protein', label: 'Protein',  short: 'Pro',  unit: 'g', cls: 'pro',  color: 'var(--pro)' },
  { k: 'c',   t: 'carbs',   label: 'Carbs',    short: 'Carb', unit: 'g', cls: 'carb', color: 'var(--carb)' },
  { k: 'f',   t: 'fat',     label: 'Fat',      short: 'Fat',  unit: 'g', cls: 'fat',  color: 'var(--fat)' },
];

const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Math.round(n).toLocaleString();
const fmt1 = n => (Math.round(n * 10) / 10).toLocaleString();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function shiftKey(k, n) { const d = parseKey(k); d.setDate(d.getDate() + n); return dayKey(d); }
function dayLabel(k) {
  if (k === today) return 'Today';
  if (k === shiftKey(today, -1)) return 'Yesterday';
  return parseKey(k).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

let today = dayKey();
let state = load();

function load() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { /* corrupt or blocked */ }
  const fresh = !s;
  s = s || {};
  const st = {
    settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
    days: s.days || {},
    favorites: s.favorites || [],
    weights: s.weights || {},
    shopping: (s.shopping || []).map(i => ({ qty: '', ...i })),
    barcodes: s.barcodes || {}, // barcode -> per-serving nutrition you've scanned or entered
    lastBackup: s.lastBackup || null,     // when you last saved a backup file
    backupSnooze: s.backupSnooze || null, // "Later" hides the reminder until this time
  };
  // First run: record the starting weight so the trend has a starting point.
  if (fresh) st.weights[today] = st.settings.weight;
  return st;
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('⚠️ Could not save to device storage'); }
}

const pickTargets = s => ({ cal: s.cal, protein: s.protein, carbs: s.carbs, fat: s.fat });
// Today always uses current settings; past days use the targets they were logged against.
function targetsFor(k) {
  const d = state.days[k];
  return k === today || !d || !d.targets ? state.settings : d.targets;
}
function todayDay() {
  if (!state.days[today]) state.days[today] = { entries: [], hoorah: false };
  state.days[today].targets = pickTargets(state.settings);
  return state.days[today];
}
function totals(k) {
  const t = { cal: 0, p: 0, c: 0, f: 0 };
  const d = state.days[k];
  if (d) for (const e of d.entries) for (const m in t) t[m] += +e[m] || 0;
  return t;
}
function isHit(k) {
  const d = state.days[k];
  if (!d || !d.entries.length) return false;
  const t = totals(k), g = targetsFor(k);
  return t.p >= g.protein && t.cal <= g.cal;
}
// Counts back from today (or yesterday, if today isn't hit yet — today is still in play).
function currentStreak() {
  let k = isHit(today) ? today : shiftKey(today, -1), n = 0;
  while (isHit(k)) { n++; k = shiftKey(k, -1); }
  return n;
}
function bestStreak() {
  const keys = Object.keys(state.days).filter(isHit).sort();
  let best = 0, run = 0, prev = null;
  for (const k of keys) {
    run = prev && shiftKey(prev, 1) === k ? run + 1 : 1;
    best = Math.max(best, run);
    prev = k;
  }
  return best;
}
function sortedWeights() {
  return Object.entries(state.weights).map(([k, w]) => ({ k, w })).sort((a, b) => a.k.localeCompare(b.k));
}
function syncCurrentWeight() {
  const ws = sortedWeights();
  if (ws.length) state.settings.weight = ws[ws.length - 1].w;
}

/* ================= Actions ================= */

function addEntry(data) {
  const e = { id: uid(), name: data.name, cal: data.cal, p: data.p, c: data.c, f: data.f, t: Date.now() };
  todayDay().entries.push(e);
  save();
  render();
  checkHoorah();
  return e;
}
function deleteEntry(id) {
  const d = todayDay();
  const i = d.entries.findIndex(e => e.id === id);
  if (i < 0) return;
  const [removed] = d.entries.splice(i, 1);
  save();
  render();
  toast(`Deleted ${removed.name}`, 'Undo', () => {
    todayDay().entries.splice(i, 0, removed);
    save(); render(); checkHoorah();
  });
}
function upsertFavorite(data, id) {
  let fav = id ? state.favorites.find(f => f.id === id)
               : state.favorites.find(f => f.name.toLowerCase() === data.name.toLowerCase());
  if (!fav) { fav = { id: uid(), uses: 0 }; state.favorites.push(fav); }
  Object.assign(fav, { name: data.name, cal: data.cal, p: data.p, c: data.c, f: data.f });
  save();
}
function logFavorite(id) {
  const fav = state.favorites.find(f => f.id === id);
  if (!fav) return;
  fav.uses = (fav.uses || 0) + 1;
  const e = addEntry(fav);
  toast(`Logged ${fav.name}`, 'Undo', () => {
    fav.uses = Math.max(0, fav.uses - 1);
    const d = todayDay();
    d.entries = d.entries.filter(x => x.id !== e.id);
    save(); render();
  });
  if (navigator.vibrate) navigator.vibrate(15);
}

/* ================= Rendering ================= */

let view = 'today';

function render() {
  $('#today-label').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const s = currentStreak();
  $('#streak').textContent = `🔥 ${s}`;
  $('#streak').classList.toggle('hot', s > 0);
  if (view === 'today') renderToday();
  if (view === 'favs') renderFavs();
  if (view === 'history') renderHistory();
  if (view === 'list') renderList();
  if (view === 'settings') renderSettings();
}

function ringHTML(m, eaten, target) {
  const left = target - eaten, over = left < 0;
  const R = 43, C = 2 * Math.PI * R;
  // The arc shows what's LEFT, so it shrinks as you eat. Full red when over.
  const frac = over ? 1 : target > 0 ? Math.max(0, left / target) : 0;
  const n = fmt(Math.abs(left));
  return `
    <div class="ring ${m.cls} ${over ? 'over' : ''}">
      <div class="ring-box">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle class="track" cx="50" cy="50" r="${R}"/>
          <circle class="arc" cx="50" cy="50" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - frac)}"/>
        </svg>
        <div class="ring-center">
          <div class="ring-num">${over ? '+' : ''}${n}<small>${m.unit}</small></div>
          <div class="ring-sub">${over ? 'over' : 'left'}</div>
        </div>
      </div>
      <div class="ring-label">${m.label}</div>
      <div class="ring-foot">${fmt(eaten)} / ${fmt(target)}${m.unit}</div>
    </div>`;
}

function entryHTML(e, attrs) {
  const time = e.t ? new Date(e.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  return `
    <button class="entry" ${attrs}>
      <div class="entry-top"><span class="entry-name">${esc(e.name)}</span><span class="entry-time">${time}</span></div>
      <div class="entry-macros"><b>${fmt(e.cal)}</b> cal · P ${fmt1(e.p)} · C ${fmt1(e.c)} · F ${fmt1(e.f)}</div>
    </button>`;
}

const WEEK = 7 * 86400000;
function backupDue() {
  const now = Date.now();
  if (state.backupSnooze && now < state.backupSnooze) return false;
  if (!state.lastBackup) return Object.keys(state.days).length > 0; // never backed up, and there's something to save
  return now - state.lastBackup >= WEEK;
}
function lastBackupText() {
  if (!state.lastBackup) return 'Never backed up';
  const days = Math.floor((Date.now() - state.lastBackup) / 86400000);
  return 'Last backup: ' + (days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`);
}

function renderToday() {
  $('#backup-banner').hidden = !backupDue();
  $('#backup-when').textContent = lastBackupText();
  const t = totals(today), g = state.settings;
  $('#rings').innerHTML = MACROS.map(m => ringHTML(m, t[m.k], g[m.t])).join('');

  const d = state.days[today];
  const has = d && d.entries.length;
  const proLeft = g.protein - t.p, calLeft = g.cal - t.cal;
  let status;
  if (isHit(today)) status = '<div class="status good">🎖️ Mission accomplished — protein hit, calories in check.</div>';
  else if (calLeft < 0) status = `<div class="status bad">🚨 ${fmt(-calLeft)} calories over target.</div>`;
  else if (has) status = `<div class="status">Need <b>${fmt(proLeft)} g protein</b> in <b>${fmt(calLeft)} cal</b>.</div>`;
  else status = '<div class="status">Log your first meal to start today\'s mission.</div>';
  $('#status').innerHTML = status;

  const favs = [...state.favorites].sort((a, b) => (b.uses || 0) - (a.uses || 0));
  $('#quick-wrap').hidden = !favs.length;
  $('#quick').innerHTML = favs.map(f => `<button class="chip" data-fav="${f.id}">+ ${esc(f.name)}</button>`).join('');

  const entries = has ? [...d.entries].reverse() : [];
  $('#log').innerHTML = entries.length
    ? entries.map(e => entryHTML(e, `data-entry="${e.id}"`)).join('')
    : '<div class="empty">Nothing logged yet. Tap <b>+</b> to add food.</div>';
}

function renderFavs() {
  const favs = [...state.favorites].sort((a, b) => a.name.localeCompare(b.name));
  $('#favs').innerHTML = favs.length
    ? favs.map(f => `
        <div class="fav-row">
          ${entryHTML({ ...f, t: 0 }, `data-fav="${f.id}"`)}
          <button class="icon-btn" data-edit-fav="${f.id}" aria-label="Edit ${esc(f.name)}">✎</button>
        </div>`).join('')
    : '<div class="empty">No favorites yet.<br>Tick <b>Save as favorite</b> when logging food, or tap <b>+</b> to create one.</div>';
}

function statHTML(value, label) { return `<div class="stat"><b>${value}</b><span>${label}</span></div>`; }

function renderHistory() {
  // ---- Weight ----
  const s = state.settings, ws = sortedWeights();
  const start = ws.length ? ws[0].w : s.weight;
  const current = ws.length ? ws[ws.length - 1].w : s.weight;
  const toGo = current - s.goalWeight;
  const change = current - start;
  $('#w-goal').textContent = `Goal ${fmt1(s.goalWeight)} lbs`;
  $('#w-stats').innerHTML =
    statHTML(fmt1(current), 'Current') +
    statHTML(toGo > 0 ? fmt1(toGo) : '🎯', toGo > 0 ? 'To go' : 'Goal hit') +
    statHTML((change > 0 ? '+' : '') + fmt1(change), 'Change');
  const span = start - s.goalWeight;
  const pct = span > 0 ? Math.max(0, Math.min(100, ((start - current) / span) * 100)) : (toGo <= 0 ? 100 : 0);
  $('#w-progress').style.width = pct + '%';
  $('#w-progress').title = `${Math.round(pct)}% of the way`;
  renderWeightChart(ws, s.goalWeight);
  $('#w-list').innerHTML = ws.slice(-5).reverse().map(({ k, w }) =>
    `<div class="w-item"><span>${dayLabel(k)}</span><span><b>${fmt1(w)}</b> lbs <button data-del-weight="${k}" aria-label="Delete">×</button></span></div>`
  ).join('');
  if (!$('#in-weight-date').value) $('#in-weight-date').value = today;

  // ---- Days ----
  const keys = Object.keys(state.days).filter(k => state.days[k].entries.length).sort().reverse();
  const past = keys.filter(k => k !== today);
  const hits = past.filter(isHit).length;
  $('#h-stats').innerHTML =
    statHTML('🔥 ' + currentStreak(), 'Streak') +
    statHTML(bestStreak(), 'Best streak') +
    statHTML(past.length ? `${hits}/${past.length}` : '—', 'Days hit');

  $('#days').innerHTML = keys.length ? keys.map(dayHTML).join('') : '<div class="empty">Your logged days will show up here.</div>';
}

function dayHTML(k) {
  const d = state.days[k], t = totals(k), g = targetsFor(k), hit = isHit(k);
  const badge = hit ? '<span class="badge hit">🎖️ HIT</span>'
    : k === today ? '<span class="badge">IN PROGRESS</span>'
    : '<span class="badge miss">✗ MISSED</span>';
  const bars = MACROS.map(m => {
    const eaten = t[m.k], target = g[m.t], over = eaten > target;
    const w = target > 0 ? Math.min(100, (eaten / target) * 100) : 0;
    const cls = over ? (m.k === 'p' ? 'good' : 'over') : '';
    return `<span>${m.short}</span><div class="bar"><i style="width:${w}%;background:${over && m.k !== 'p' ? 'var(--over)' : m.color}"></i></div>` +
      `<span class="v ${cls}">${fmt(eaten)} / ${fmt(target)}${m.unit}</span>`;
  }).join('');
  const entries = d.entries.map(e =>
    `<div><span>${esc(e.name)}</span><span>${fmt(e.cal)} cal · P${fmt(e.p)} C${fmt(e.c)} F${fmt(e.f)}</span></div>`).join('');
  return `
    <details class="day">
      <summary><div class="day-head"><span>${dayLabel(k)}</span>${badge}</div><div class="bars">${bars}</div></summary>
      <div class="day-entries">${entries}</div>
    </details>`;
}

function renderWeightChart(ws, goal) {
  const box = $('#w-chart');
  if (!ws.length) { box.innerHTML = ''; return; }
  const W = 320, H = 170, L = 34, Rm = 40, T = 12, B = 22;
  const times = ws.map(p => parseKey(p.k).getTime());
  const t0 = times[0], t1 = Math.max(times[times.length - 1], t0 + 86400000);
  const vals = ws.map(p => p.w).concat(goal);
  let lo = Math.floor(Math.min(...vals) - 2), hi = Math.ceil(Math.max(...vals) + 2);
  const x = t => L + ((t - t0) / (t1 - t0)) * (W - L - Rm);
  const y = v => T + ((hi - v) / (hi - lo)) * (H - T - B);

  // 3 horizontal gridlines with labels
  let grid = '';
  for (let i = 0; i <= 2; i++) {
    const v = lo + ((hi - lo) * i) / 2;
    grid += `<line class="grid" x1="${L}" x2="${W - Rm}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`;
  }
  const pts = ws.map((p, i) => [x(times[i]), y(p.w)]);
  const last = pts[pts.length - 1];
  const fmtD = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  box.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight trend">
      ${grid}
      <line class="goal" x1="${L}" x2="${W - Rm}" y1="${y(goal)}" y2="${y(goal)}"/>
      <text x="${W - Rm + 4}" y="${y(goal) + 4}" style="fill:var(--good)">Goal</text>
      ${pts.length > 1 ? `<polyline class="line" points="${pts.map(p => p.join(',')).join(' ')}"/>` : ''}
      ${pts.length <= 40 ? pts.map(p => `<circle class="pt" cx="${p[0]}" cy="${p[1]}" r="4"/>`).join('') : ''}
      <text class="lbl-strong" x="${last[0] + 7}" y="${last[1] - 6}">${fmt1(ws[ws.length - 1].w)}</text>
      <text x="${L}" y="${H - 4}">${fmtD(t0)}</text>
      <text x="${W - Rm}" y="${H - 4}" text-anchor="end">${fmtD(times[times.length - 1])}</text>
      <line class="xhair" id="xhair" y1="${T}" y2="${H - B}" visibility="hidden"/>
      <rect x="${L}" y="0" width="${W - L - Rm}" height="${H}" fill="transparent" id="hit"/>
    </svg>
    <div class="tip" id="tip" hidden></div>`;

  // Crosshair + tooltip: nearest weigh-in to the finger/cursor.
  const svg = box.querySelector('svg'), tip = $('#tip'), xh = $('#xhair');
  const show = ev => {
    const r = svg.getBoundingClientRect();
    const sx = ((ev.clientX - r.left) / r.width) * W;
    let best = 0;
    pts.forEach((p, i) => { if (Math.abs(p[0] - sx) < Math.abs(pts[best][0] - sx)) best = i; });
    const [px] = pts[best];
    xh.setAttribute('x1', px); xh.setAttribute('x2', px); xh.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.style.left = Math.max(50, Math.min(r.width - 50, (px / W) * r.width)) + 'px';
    tip.textContent = `${fmtD(times[best])}: ${fmt1(ws[best].w)} lbs`;
  };
  const hide = () => { tip.hidden = true; xh.setAttribute('visibility', 'hidden'); };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', hide);
}

function renderList() {
  state.shopping.forEach(i => { if (!i.section) i.section = guessSection(i.name); });
  const need = state.shopping.filter(i => !i.done);
  const done = state.shopping.filter(i => i.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  const row = i => `
    <div class="shop-row ${i.done ? 'done' : ''}">
      <button class="shop-item" data-shop="${i.id}"><span class="box">✓</span><span class="shop-name">${esc(i.name)}</span>${i.qty ? `<span class="shop-qty">${esc(i.qty)}</span>` : ''}</button>
      <button class="icon-btn" data-edit-shop="${i.id}" aria-label="Edit ${esc(i.name)}">✎</button>
    </div>`;
  // "To get" is grouped by store section, in the order you'd walk the store.
  const grouped = SECTIONS.map(sec => {
    const items = need.filter(i => (i.section || 'other') === sec.id);
    return items.length ? `<div class="shop-sec">${sec.icon} ${sec.label}</div>` + items.map(row).join('') : '';
  }).join('');
  $('#list-need-title').textContent = need.length ? `To get (${need.length})` : 'To get';
  $('#list-need').innerHTML = need.length ? grouped
    : `<div class="empty">${done.length ? '🎉 Got everything on the list!' : 'List is empty. Add what you need above.'}</div>`;
  $('#list-done-wrap').hidden = !done.length;
  $('#list-done').innerHTML = done.map(row).join('');

  const onList = new Set(need.map(i => i.name.toLowerCase()));
  const favs = state.favorites.filter(f => !onList.has(f.name.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
  $('#list-fav-wrap').hidden = !favs.length;
  $('#list-favs').innerHTML = favs.map(f => `<button class="chip" data-shop-fav="${f.id}">+ ${esc(f.name)}</button>`).join('');
}

// Store walk order.
const SECTIONS = [
  { id: 'produce', icon: '🥬', label: 'Produce' },
  { id: 'meat',    icon: '🥩', label: 'Meat & Seafood' },
  { id: 'dairy',   icon: '🥚', label: 'Dairy & Eggs' },
  { id: 'bakery',  icon: '🍞', label: 'Bakery' },
  { id: 'pantry',  icon: '🥫', label: 'Pantry' },
  { id: 'frozen',  icon: '🧊', label: 'Frozen' },
  { id: 'drinks',  icon: '🥤', label: 'Drinks' },
  { id: 'other',   icon: '🛒', label: 'Other' },
];
// Checked in this order, so "frozen berries" lands in Frozen and "peanut butter" in Pantry.
const SECTION_WORDS = [
  ['frozen', 'frozen|ice'],
  ['pantry', 'peanut butter|almond butter|protein|powder|canned|broth|stock|chips|crisps|crackers|cookies|snacks?|pretzels|popcorn'],
  ['drinks', 'water|soda|coffee|tea|juice|drink|seltzer|gatorade|electrolyte|kombucha|beer|wine'],
  ['meat', 'chicken|beef|steak|turkey|pork|bacon|sausage|fish|salmon|tuna|shrimp|ground|ham|lamb|jerky|thigh|breast|tilapia|cod|ribs?|brisket|meat|deli'],
  ['dairy', 'milk|eggs?|cheese|yogurt|butter|cream|cottage|kefir|whites?'],
  ['bakery', 'bread|bagels?|tortillas?|buns?|rolls?|wraps?|pita|muffins?'],
  ['produce', 'apples?|bananas?|berry|berries|spinach|lettuce|kale|broccoli|avocados?|tomato(es)?|onions?|garlic|peppers?|potato(es)?|carrots?|cucumbers?|lemons?|limes?|fruit|veg(gie|etable)s?|salad|celery|mushrooms?|zucchini|cauliflower|asparagus|grapes?|oranges?|herbs?|cilantro|parsley|greens|cabbage|squash|corn|beans? sprouts?'],
  ['pantry', 'rice|oats?|oatmeal|pasta|beans?|oil|sauce|spices?|seasoning|nuts?|almonds?|peanuts?|cereal|flour|sugar|salt|honey|soup|bars?|chips|salsa|vinegar|mustard|ketchup|mayo|jerky'],
];
function guessSection(name) {
  const n = String(name || '').toLowerCase();
  for (const [sec, words] of SECTION_WORDS) if (new RegExp(`\\b(${words})\\b`).test(n)) return sec;
  return 'other';
}
// "3 lb chicken" -> qty "3 lb", name "chicken". "2x eggs" -> qty "2".
const QTY_RE = /^(\d+(?:[.\/]\d+)?\s*(?:x|lbs?|oz|kg|g|dozen|doz|packs?|bags?|cans?|bottles?|box(?:es)?|ct|cartons?|jars?|bunch(?:es)?|heads?)?)\s+(.+)$/i;
function parseItem(text) {
  const m = text.match(QTY_RE);
  const cap = n => n.charAt(0).toUpperCase() + n.slice(1);
  return m ? { qty: m[1].replace(/\s*x$/i, '').trim(), name: cap(m[2].trim()) } : { qty: '', name: cap(text.trim()) };
}

function addShopItem(name, qty, code) {
  const existing = state.shopping.find(i => i.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (qty) existing.qty = qty;
    if (code) existing.code = code;
    if (!existing.done && !qty) return false;
    existing.done = false;
    return true;
  }
  state.shopping.push({ id: uid(), name, qty, section: guessSection(name), done: false, ...(code ? { code } : {}) });
  return true;
}
function addShopItems(text, code) {
  let added = 0;
  for (const part of text.split(',').map(s => s.trim()).filter(Boolean)) {
    const { qty, name } = parseItem(part);
    if (addShopItem(name, qty, code)) added++;
  }
  save(); render();
  return added;
}

/* ---- Shopping item sheet ---- */
let itemId = null, itemSection = 'other';
function paintSections() {
  $('#it-sections').innerHTML = SECTIONS.map(s =>
    `<button type="button" data-sec="${s.id}" class="${s.id === itemSection ? 'on' : ''}">${s.icon} ${s.label}</button>`).join('');
}
function openItemSheet(id) {
  const it = state.shopping.find(i => i.id === id);
  if (!it) return;
  itemId = id; itemSection = it.section || 'other';
  $('#it-name').value = it.name; $('#it-qty').value = it.qty || '';
  paintSections();
  $('#item-backdrop').hidden = false;
}
function closeItemSheet() { $('#item-backdrop').hidden = true; itemId = null; document.activeElement.blur(); }
$('#it-sections').addEventListener('click', ev => {
  const b = ev.target.closest('[data-sec]');
  if (b) { itemSection = b.dataset.sec; paintSections(); }
});
$('#item-form').addEventListener('submit', ev => {
  ev.preventDefault();
  const it = state.shopping.find(i => i.id === itemId);
  if (it) Object.assign(it, { name: $('#it-name').value.trim() || it.name, qty: $('#it-qty').value.trim(), section: itemSection });
  closeItemSheet(); save(); render();
});
$('#it-cancel').addEventListener('click', closeItemSheet);
$('#item-backdrop').addEventListener('click', ev => { if (ev.target.id === 'item-backdrop') closeItemSheet(); });
$('#it-delete').addEventListener('click', () => {
  const i = state.shopping.findIndex(x => x.id === itemId);
  closeItemSheet();
  if (i < 0) return;
  const [removed] = state.shopping.splice(i, 1);
  save(); render();
  toast(`Removed ${removed.name}`, 'Undo', () => { state.shopping.splice(i, 0, removed); save(); render(); });
});
// Opens the normal Log food form, pre-filled from a matching favorite if there is one.
$('#it-log').addEventListener('click', () => {
  const name = $('#it-name').value.trim();
  const item = state.shopping.find(i => i.id === itemId);
  closeItemSheet();
  if (item && item.code) { openSheet('add', null, { name }); fillFromBarcode(item.code); return; }
  const fav = state.favorites.find(f => f.name.toLowerCase() === name.toLowerCase());
  openSheet('add', null, fav || { name });
}); 

function renderSettings() {
  const s = state.settings;
  $('#s-cal').value = s.cal; $('#s-protein').value = s.protein;
  $('#s-carbs').value = s.carbs; $('#s-fat').value = s.fat;
  $('#s-weight').value = s.weight; $('#s-goal').value = s.goalWeight;
  $('#last-backup').textContent = lastBackupText();
}

function setView(v) {
  view = v;
  document.querySelectorAll('.view').forEach(el => { el.hidden = el.id !== 'view-' + v; });
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $('#fab').hidden = !(v === 'today' || v === 'favs');
  $('#fab').setAttribute('aria-label', v === 'favs' ? 'New favorite' : 'Add food');
  window.scrollTo(0, 0);
  render();
  updateWakeLock();
}

/* ================= Add / edit sheet ================= */

let sheet = null; // { mode: 'add' | 'entry' | 'fav', id }
const IN = ['cal', 'p', 'c', 'f'];

function openSheet(mode, item, prefill) {
  sheet = { mode, id: item && item.id };
  const src = item || prefill;
  $('#sheet-title').textContent =
    mode === 'add' ? 'Log food' : mode === 'entry' ? 'Edit entry' : item ? 'Edit favorite' : 'New favorite';
  $('#sheet-save').textContent = mode === 'add' ? 'Log it' : 'Save';
  $('#in-name').value = src ? src.name : '';
  IN.forEach(k => { $('#in-' + k).value = src && src[k] != null ? +(+src[k]).toFixed(1) : ''; });
  $('#fav-row').hidden = mode === 'fav';
  $('#in-fav').checked = false;
  $('#sheet-delete').hidden = !item;
  $('#backdrop').hidden = false;
  resetScanState();
  $('#scan-food').hidden = mode === 'entry';
  if (!item) (prefill ? $('#in-cal') : $('#in-name')).focus();
}
function closeSheet() { $('#backdrop').hidden = true; sheet = null; document.activeElement.blur(); }

function readForm() {
  const num = id => Math.max(0, parseFloat($('#in-' + id).value) || 0);
  const data = { name: $('#in-name').value.trim(), p: num('p'), c: num('c'), f: num('f') };
  const calRaw = $('#in-cal').value.trim();
  data.cal = calRaw === '' ? Math.round(data.p * 4 + data.c * 4 + data.f * 9) : num('cal');
  if (!data.name && !data.cal && !data.p && !data.c && !data.f) return null;
  if (!data.name) data.name = 'Quick add';
  return data;
}

$('#entry-form').addEventListener('submit', ev => {
  ev.preventDefault();
  const data = readForm();
  if (!data) { $('#in-name').focus(); return; }
  const { mode, id, code } = sheet;
  const asFav = $('#in-fav').checked;
  if (code) rememberBarcode(code, data);
  if (perServing && servings !== 1) data.name = `${data.name} ×${servings}`;
  closeSheet();
  if (mode === 'add') {
    addEntry(data);
    if (asFav) upsertFavorite(data);
    toast(`Logged ${data.name}${asFav ? ' ★' : ''}`);
  } else if (mode === 'entry') {
    const e = todayDay().entries.find(x => x.id === id);
    if (e) Object.assign(e, data);
    if (asFav) upsertFavorite(data);
    save(); render(); checkHoorah();
    toast('Entry updated');
  } else {
    upsertFavorite(data, id);
    render();
    toast(id ? 'Favorite updated' : 'Favorite saved');
  }
});
$('#sheet-cancel').addEventListener('click', closeSheet);
$('#backdrop').addEventListener('click', ev => { if (ev.target.id === 'backdrop') closeSheet(); });
$('#sheet-delete').addEventListener('click', () => {
  const { mode, id } = sheet;
  closeSheet();
  if (mode === 'entry') deleteEntry(id);
  if (mode === 'fav') {
    const i = state.favorites.findIndex(f => f.id === id);
    const [removed] = state.favorites.splice(i, 1);
    save(); render();
    toast(`Deleted ${removed.name}`, 'Undo', () => { state.favorites.splice(i, 0, removed); save(); render(); });
  }
});
// Enter on the name field jumps to calories rather than submitting.
$('#in-name').addEventListener('keydown', ev => {
  if (ev.key === 'Enter') { ev.preventDefault(); $('#in-cal').focus(); }
});

/* ================= Barcode scanning ================= */

const OFF_URL = 'https://world.openfoodfacts.org/api/v2/product/';
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
let detectorPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}
// Android Chrome has a built-in barcode reader; iPhone uses the bundled one in vendor/.
function getDetector() {
  if (!detectorPromise) detectorPromise = (async () => {
    if ('BarcodeDetector' in window) {
      try {
        const ok = await window.BarcodeDetector.getSupportedFormats();
        if (FORMATS.some(f => ok.includes(f))) return new window.BarcodeDetector({ formats: FORMATS });
      } catch (e) { /* fall through to the bundled reader */ }
    }
    await loadScript('vendor/barcode-detector.js');
    const api = window.BarcodeDetectionAPI;
    api.prepareZXingModule({
      overrides: { locateFile: (path, prefix) => path.endsWith('.wasm') ? new URL('vendor/' + path, location.href).href : prefix + path },
    });
    return new api.BarcodeDetector({ formats: FORMATS });
  })().catch(e => { detectorPromise = null; throw e; });
  return detectorPromise;
}

let scanStream = null, scanResolve = null, scanRAF = 0;

// Opens the camera; resolves with the barcode digits, or null if cancelled.
function scanBarcode() {
  return new Promise(resolve => {
    scanResolve = resolve;
    $('#scan-code').value = '';
    $('#scan-msg').textContent = 'Starting camera…';
    $('#scanner').hidden = false;
    startCamera();
  });
}
async function startCamera() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (e) {
    $('#scan-msg').textContent = e && e.name === 'NotAllowedError'
      ? 'Camera access is off. Allow it, or type the number below.'
      : 'Camera not available. Type the barcode number below.';
    return;
  }
  if (!scanResolve) { stream.getTracks().forEach(t => t.stop()); return; } // cancelled while starting
  scanStream = stream;
  const video = $('#scan-video');
  video.srcObject = stream;
  try { await video.play(); } catch (e) { /* autoplay attribute covers it */ }
  let detector;
  try { detector = await getDetector(); }
  catch (e) { $('#scan-msg').textContent = 'Scanner failed to load. Type the barcode number below.'; return; }
  if (!scanStream) return;
  $('#scan-msg').textContent = 'Point at a barcode';
  let busy = false, last = 0;
  const tick = async now => {
    if (!scanStream) return;
    if (!busy && now - last > 150 && video.readyState >= 2) {
      busy = true; last = now;
      try {
        const found = await detector.detect(video);
        if (found.length && scanStream) { finishScan(found[0].rawValue); return; }
      } catch (e) { /* keep trying */ }
      busy = false;
    }
    scanRAF = requestAnimationFrame(tick);
  };
  scanRAF = requestAnimationFrame(tick);
}
function stopCamera() {
  cancelAnimationFrame(scanRAF);
  if (scanStream) scanStream.getTracks().forEach(t => t.stop());
  scanStream = null;
  $('#scan-video').srcObject = null;
}
function finishScan(code) {
  stopCamera();
  $('#scanner').hidden = true;
  const resolve = scanResolve;
  scanResolve = null;
  if (code && navigator.vibrate) navigator.vibrate(60);
  if (resolve) resolve(code ? String(code).replace(/\D/g, '') : null);
}
$('#scan-cancel').addEventListener('click', () => finishScan(null));
$('#scan-manual').addEventListener('submit', ev => {
  ev.preventDefault();
  const code = $('#scan-code').value.replace(/\D/g, '');
  if (code.length >= 6) finishScan(code);
});

// Your own saved barcodes first, then Open Food Facts.
// Returns product info, null if not found, or throws if offline.
async function lookupBarcode(code) {
  if (state.barcodes[code]) return { ...state.barcodes[code], code, source: 'saved' };
  const res = await fetch(`${OFF_URL}${code}.json?fields=product_name,product_name_en,brands,serving_size,serving_quantity,nutriments`);
  const json = await res.json().catch(() => null);
  if (!json || json.status !== 1 || !json.product) return null;
  return fromOpenFoodFacts(json.product, code);
}
function fromOpenFoodFacts(p, code) {
  const n = p.nutriments || {};
  const num = key => { const v = parseFloat(n[key]); return isFinite(v) ? v : null; };
  const pick = suffix => {
    let cal = num('energy-kcal' + suffix);
    if (cal == null) { const kj = num('energy-kj' + suffix) ?? num('energy' + suffix); if (kj != null) cal = kj / 4.184; }
    return { cal, p: num('proteins' + suffix), c: num('carbohydrates' + suffix), f: num('fat' + suffix) };
  };
  let per = pick('_serving'), serving = (p.serving_size || '').trim();
  if (per.cal == null && per.p == null) {
    // No per-serving numbers: scale from per-100 g using the serving weight, or fall back to 100 g.
    const h = pick('_100g'), grams = parseFloat(p.serving_quantity);
    const m = grams > 0 ? grams / 100 : 1;
    if (!(grams > 0)) serving = '100 g';
    else if (!serving) serving = `${grams} g`;
    per = Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v == null ? null : v * m]));
  }
  const brand = (p.brands || '').split(',')[0].trim();
  let name = (p.product_name_en || p.product_name || '').trim();
  if (brand && !name.toLowerCase().includes(brand.toLowerCase())) name = `${brand} ${name}`.trim();
  const r = (v, d) => v == null ? null : Math.round(v * d) / d;
  return {
    code, source: 'off', name: name || 'Scanned item', serving,
    cal: r(per.cal, 1), p: r(per.p, 10), c: r(per.c, 10), f: r(per.f, 10),
    hasNutrition: [per.cal, per.p, per.c, per.f].some(v => v != null),
  };
}
function rememberBarcode(code, data) {
  const prev = state.barcodes[code] || {};
  const per = k => Math.round(((+data[k] || 0) / servings) * 10) / 10;
  state.barcodes[code] = { name: data.name, serving: (sheet && sheet.serving) || prev.serving || '', cal: per('cal'), p: per('p'), c: per('c'), f: per('f') };
  save();
}

/* ---- Servings stepper in the Log food form ---- */
let servings = 1, perServing = null; // macros for ONE serving while a barcode is in play

function resetScanState() {
  servings = 1; perServing = null;
  $('#suggest').hidden = true;
  $('#serving-row').hidden = true;
  $('#scan-note').hidden = true;
  $('#in-servings').value = 1;
}
function setServings(v, fromInput) {
  if (!(v > 0) || !perServing) return;
  servings = Math.round(v * 100) / 100;
  if (!fromInput) $('#in-servings').value = servings;
  IN.forEach(k => {
    const base = perServing[k];
    $('#in-' + k).value = base == null ? '' : +(base * servings).toFixed(k === 'cal' ? 0 : 1);
  });
}
function scanNote(text) { $('#scan-note').textContent = text; $('#scan-note').hidden = !text; }

async function fillFromBarcode(code) {
  if (!sheet) return;
  sheet.code = code;
  $('#serving-row').hidden = false;
  $('#serving-info').textContent = '';
  perServing = { cal: null, p: null, c: null, f: null };
  scanNote('Looking up ' + code + '…');
  let info;
  try { info = await lookupBarcode(code); } catch (e) { info = undefined; }
  if (!sheet || sheet.code !== code) return; // form was closed or rescanned meanwhile
  if (info && info.hasNutrition !== false) {
    $('#in-name').value = info.name;
    perServing = { cal: info.cal, p: info.p, c: info.c, f: info.f };
    sheet.serving = info.serving;
    setServings(1);
    $('#serving-info').textContent = info.serving ? `1 serving = ${info.serving}` : 'Per serving';
    scanNote(info.source === 'saved' ? '✓ From your saved barcodes' : '✓ Found in Open Food Facts. Check it against the label.');
  } else {
    if (info && info.name) $('#in-name').value = info.name;
    IN.forEach(k => { $('#in-' + k).value = ''; });
    $('#serving-info').textContent = 'Enter 1 serving from the label';
    scanNote(info === undefined
      ? "Couldn't reach the food database. Enter it from the label and it'll be saved for next time."
      : "No nutrition info for this one. Enter it from the label and it'll be saved for next time.");
  }
}

$('#scan-food').addEventListener('click', async () => {
  const code = await scanBarcode();
  if (code) fillFromBarcode(code);
});
// Typing in a macro box updates the per-serving numbers, so the stepper scales what you typed.
IN.forEach(k => $('#in-' + k).addEventListener('input', () => {
  if (!perServing) return;
  const v = parseFloat($('#in-' + k).value);
  perServing[k] = isFinite(v) ? v / servings : null;
}));
$('#in-servings').addEventListener('input', () => setServings(parseFloat($('#in-servings').value), true));
$('#srv-minus').addEventListener('click', () => setServings(Math.max(0.5, servings - 0.5)));
$('#srv-plus').addEventListener('click', () => setServings(servings + 0.5));

/* ---- Scan into the shopping list ---- */
let pendingListCode = null;
$('#scan-list').addEventListener('click', async () => {
  const code = await scanBarcode();
  if (!code) return;
  toast('Looking up…');
  let info;
  try { info = await lookupBarcode(code); } catch (e) { info = undefined; }
  if (info && info.name && info.name !== 'Scanned item') {
    if (info.source === 'off' && info.hasNutrition) {
      state.barcodes[code] = { name: info.name, serving: info.serving, cal: info.cal ?? 0, p: info.p ?? 0, c: info.c ?? 0, f: info.f ?? 0 };
    }
    addShopItem(info.name, '', code);
    save(); render();
    toast(`Added ${info.name}`);
  } else {
    pendingListCode = code;
    $('#in-item').focus();
    toast(info === undefined ? "Couldn't reach the food database. Type the name and tap Add." : 'Not found. Type the name and tap Add.');
  }
});

/* ================= Food autocomplete ================= */

// cafeteria.json is refreshed weekly from the school's Nutrislice menu by a GitHub Action.
let cafeteria = [];
async function loadCafeteria() {
  try {
    const res = await fetch('cafeteria.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const data = await res.json();
    cafeteria = (data.items || []).filter(i => i.cal != null || i.p != null);
  } catch (e) { /* offline and never loaded: just no school suggestions */ }
}

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Favorites first, then your scanned barcodes, then the school menu. Every typed word must match.
function suggestions(query) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const words = q.split(/\s+/);
  const pool = [
    ...state.favorites.map(f => ({ ...f, src: 'fav' })),
    ...Object.entries(state.barcodes).map(([code, b]) => ({ ...b, code, src: 'scan' })),
    ...cafeteria.map(i => ({ ...i, src: 'school' })),
  ];
  const seen = new Set(), out = [];
  for (const it of pool) {
    const name = (it.name || '').toLowerCase();
    if (!name || seen.has(name) || !words.every(w => name.includes(w))) continue;
    seen.add(name);
    const where = name.startsWith(q) ? 0 : new RegExp('\\b' + escRe(words[0])).test(name) ? 1 : 2;
    out.push({ it, score: where + { fav: 0, scan: 0.1, school: 0.2 }[it.src] });
  }
  return out.sort((a, b) => a.score - b.score || a.it.name.localeCompare(b.it.name)).slice(0, 6).map(x => x.it);
}

let suggestList = [];
function showSuggest() {
  suggestList = suggestions($('#in-name').value);
  const icon = { fav: '⭐', scan: '📷', school: '🏫' };
  $('#suggest').innerHTML = suggestList.map((it, i) => {
    const meta = [it.cal != null ? `${fmt(it.cal)} cal` : '', it.p != null ? `P ${fmt1(it.p)}` : '', it.serving ? esc(it.serving) : '']
      .filter(Boolean).join(' · ');
    return `<button type="button" class="sug" data-sug="${i}"><span class="sug-name">${esc(it.name)}</span><span class="sug-meta">${icon[it.src]} ${meta}</span></button>`;
  }).join('');
  $('#suggest').hidden = !suggestList.length;
}
$('#in-name').addEventListener('input', showSuggest);
// Hide the list once you move on to another box.
$('#entry-form').addEventListener('focusin', ev => {
  if (ev.target.id !== 'in-name' && !ev.target.closest('#suggest')) $('#suggest').hidden = true;
});
$('#suggest').addEventListener('click', ev => {
  const b = ev.target.closest('[data-sug]');
  if (!b || !sheet) return;
  const it = suggestList[+b.dataset.sug];
  $('#in-name').value = it.name;
  $('#suggest').hidden = true;
  $('#in-name').blur();
  if (it.code) { fillFromBarcode(it.code); return; } // saved barcode: same as scanning it
  sheet.code = null;
  perServing = { cal: it.cal ?? null, p: it.p ?? null, c: it.c ?? null, f: it.f ?? null };
  setServings(1);
  $('#serving-row').hidden = false;
  $('#serving-info').textContent = it.serving ? `1 serving = ${it.serving}` : 'Per serving';
  scanNote(it.src === 'school' ? '🏫 From the NPHS cafeteria menu' : '');
});

/* ================= HOORAH ================= */

function checkHoorah() {
  const d = state.days[today];
  if (d && !d.hoorah && isHit(today)) {
    d.hoorah = true; // once per day, even if you edit later
    save();
    render();
    celebrate();
  }
}

let hoorahTimer;
function celebrate() {
  const s = currentStreak();
  $('#hoorah-sub').innerHTML = `Protein ✔ Calories ✔<br>🔥 ${s}-day streak`;
  $('#hoorah').hidden = false;
  clearTimeout(hoorahTimer);
  hoorahTimer = setTimeout(() => { $('#hoorah').hidden = true; }, 4500);
  if (navigator.vibrate) navigator.vibrate([200, 80, 200, 80, 500]);
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) confetti();
}
$('#hoorah').addEventListener('click', () => { $('#hoorah').hidden = true; });

function confetti() {
  const cv = $('#confetti'), ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1, W = innerWidth, H = innerHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cv.hidden = false;
  const colors = ['#ff8a3d', '#4da6ff', '#b388ff', '#ffd23d', '#3ddc97', '#ff4d5e', '#ffffff'];
  const parts = [];
  // Two cannons from the bottom corners, plus a sprinkle from the top.
  for (let i = 0; i < 220; i++) {
    const side = i % 3; // 0 left, 1 right, 2 top
    const burst = side === 2
      ? { x: Math.random() * W, y: -20, vx: (Math.random() - 0.5) * 4, vy: Math.random() * 3 }
      : { x: side ? W + 10 : -10, y: H * 0.95, vx: (side ? -1 : 1) * (4 + Math.random() * 10), vy: -(14 + Math.random() * 14) };
    parts.push({ ...burst, w: 6 + Math.random() * 6, h: 10 + Math.random() * 8, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
      c: colors[i % colors.length], delay: side === 2 ? Math.random() * 600 : 0 });
  }
  const DUR = 4200, t0 = performance.now();
  (function frame(now) {
    const el = now - t0;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = Math.max(0, Math.min(1, (DUR - el) / 800));
    for (const p of parts) {
      if (el < p.delay) continue;
      p.vy = Math.min(p.vy + 0.4, 7); p.vx *= 0.985;
      p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2 * Math.abs(Math.cos(p.r * 1.7)), p.w, p.h * Math.abs(Math.cos(p.r * 1.7)) + 1);
      ctx.restore();
    }
    if (el < DUR) requestAnimationFrame(frame); else { ctx.clearRect(0, 0, W, H); cv.hidden = true; }
  })(t0);
}

/* ================= Toast ================= */

let toastTimer;
function toast(msg, action, fn) {
  $('#toast-msg').textContent = msg;
  const btn = $('#toast-btn');
  btn.textContent = action || '';
  btn.onclick = () => { $('#toast').hidden = true; if (fn) fn(); };
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, action ? 5000 : 2200);
}

/* ================= Events ================= */

document.querySelector('.tabs').addEventListener('click', ev => {
  const b = ev.target.closest('button[data-view]');
  if (b) setView(b.dataset.view);
});
$('#fab').addEventListener('click', () => openSheet(view === 'favs' ? 'fav' : 'add'));

document.addEventListener('click', ev => {
  const t = ev.target.closest('[data-fav],[data-entry],[data-edit-fav],[data-del-weight],[data-shop],[data-edit-shop],[data-shop-fav]');
  if (!t) return;
  if (t.dataset.fav) logFavorite(t.dataset.fav);
  else if (t.dataset.entry) openSheet('entry', todayDay().entries.find(e => e.id === t.dataset.entry));
  else if (t.dataset.editFav) openSheet('fav', state.favorites.find(f => f.id === t.dataset.editFav));
  else if (t.dataset.shop) {
    const item = state.shopping.find(i => i.id === t.dataset.shop);
    if (item) { item.done = !item.done; item.doneAt = Date.now(); save(); render(); }
    if (navigator.vibrate) navigator.vibrate(10);
  }
  else if (t.dataset.editShop) openItemSheet(t.dataset.editShop);
  else if (t.dataset.shopFav) {
    const fav = state.favorites.find(f => f.id === t.dataset.shopFav);
    if (fav) { addShopItems(fav.name); toast(`Added ${fav.name} to list`); }
  }
  else if (t.dataset.delWeight) {
    const k = t.dataset.delWeight, w = state.weights[k];
    delete state.weights[k];
    syncCurrentWeight(); save(); render();
    toast('Weigh-in deleted', 'Undo', () => { state.weights[k] = w; syncCurrentWeight(); save(); render(); });
  }
});

$('#weight-form').addEventListener('submit', ev => {
  ev.preventDefault();
  const w = parseFloat($('#in-weight').value), k = $('#in-weight-date').value || today;
  if (!(w > 0)) return;
  state.weights[k] = Math.round(w * 10) / 10;
  syncCurrentWeight(); save();
  $('#in-weight').value = ''; $('#in-weight').blur();
  render();
  const toGo = state.settings.weight - state.settings.goalWeight;
  toast(toGo > 0 ? `Logged ${fmt1(w)} lbs — ${fmt1(toGo)} to go` : `Logged ${fmt1(w)} lbs — GOAL REACHED 🎯`);
});

$('#settings-form').addEventListener('submit', ev => {
  ev.preventDefault();
  const v = id => parseFloat($(id).value);
  const s = state.settings;
  Object.assign(s, { cal: v('#s-cal'), protein: v('#s-protein'), carbs: v('#s-carbs'), fat: v('#s-fat'), goalWeight: v('#s-goal') });
  const w = v('#s-weight');
  if (w > 0 && w !== s.weight) { state.weights[today] = w; syncCurrentWeight(); }
  if (state.days[today]) todayDay();
  save(); render();
  toast('Settings saved');
  checkHoorah();
});

// On iPhone this opens the Share sheet, so you can pick "Save to Files" -> iCloud Drive.
async function backupNow() {
  const name = `operation-macro-${today}.json`;
  const json = JSON.stringify({ ...state, lastBackup: Date.now(), backupSnooze: null }, null, 2);
  const file = new File([json], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Operation Macro backup' }); }
    catch (e) {
      if (e.name === 'AbortError') { toast('Backup not saved'); return; } // closed the Share sheet
      downloadFile(file);
    }
  } else {
    downloadFile(file);
  }
  state.lastBackup = Date.now();
  state.backupSnooze = null;
  save(); render();
  toast('Backup saved 💾');
}
function downloadFile(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$('#export-btn').addEventListener('click', backupNow);
$('#backup-now').addEventListener('click', backupNow);
$('#backup-later').addEventListener('click', () => {
  state.backupSnooze = Date.now() + 86400000; // ask again tomorrow
  save(); render();
});
$('#import-file').addEventListener('change', async ev => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data.days !== 'object') throw new Error('bad file');
    if (!confirm('Replace everything on this phone with this backup?')) return;
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
    state = load(); render();
    toast('Backup restored');
  } catch (e) { toast('That file is not an Operation Macro backup'); }
});
$('#reset-btn').addEventListener('click', () => {
  if (!confirm('Erase ALL food logs, favorites, weigh-ins and settings?')) return;
  if (!confirm('Really? This cannot be undone.')) return;
  localStorage.removeItem(STORE_KEY);
  state = load(); save(); render();
  toast('All data erased');
});

$('#list-form').addEventListener('submit', ev => {
  ev.preventDefault();
  const input = $('#in-item');
  const code = pendingListCode && !input.value.includes(',') ? pendingListCode : undefined;
  if (addShopItems(input.value, code)) { input.value = ''; pendingListCode = null; }
  input.focus(); // stay ready for the next item
});
$('#list-clear').addEventListener('click', () => {
  const before = state.shopping;
  const n = before.filter(i => i.done).length;
  state.shopping = before.filter(i => !i.done);
  save(); render();
  toast(`Cleared ${n} item${n === 1 ? '' : 's'}`, 'Undo', () => { state.shopping = before; save(); render(); });
});
$('#list-uncheck').addEventListener('click', () => {
  const before = state.shopping.map(i => ({ ...i }));
  state.shopping.forEach(i => { i.done = false; });
  save(); render();
  toast('Everything unchecked', 'Undo', () => { state.shopping = before; save(); render(); });
});

// Keep the screen on while the shopping list is open (so it doesn't lock mid-aisle).
let wakeLock = null;
async function updateWakeLock() {
  try {
    if (view === 'list' && !document.hidden && 'wakeLock' in navigator) {
      if (!wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    } else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}
document.addEventListener('visibilitychange', updateWakeLock);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadCafeteria(); });

/* ================= Midnight rollover ================= */

function checkRollover() {
  const k = dayKey();
  if (k !== today) {
    today = k;
    $('#in-weight-date').value = today;
    render();
  }
}
setInterval(checkRollover, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkRollover(); });
window.addEventListener('focus', checkRollover);

/* ================= Boot ================= */

save();
loadCafeteria();
setView('today');
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
