'use strict';

/* ================= Data ================= */

// Invite-only (config.js + invites.json). Each person's email is their profile: their data lives
// on the phone under its own key, and nothing about it is sent anywhere.
const AUTH = window.OPMACRO_CONFIG || {};
const authOn = !!AUTH.inviteOnly;
const ACCOUNT_SLOT = 'opmacro_account';
const account = authOn ? (() => { try { return JSON.parse(localStorage.getItem(ACCOUNT_SLOT)); } catch (e) { return null; } })() : null;
const LEGACY_KEY = 'opmacro_v1', LEGACY_AI_KEY = 'opmacro_ai_key';
// Signed out (with sign-in on): nothing is read or written until someone signs in.
const APP_VERSION = 'v32'; // keep in step with sw.js VERSION
const STORE_KEY = !authOn ? LEGACY_KEY : account ? `${LEGACY_KEY}:${account.id}` : null;
const DEFAULT_SETTINGS = { cal: 2200, protein: 225, carbs: 65, fat: 70, weight: 250, goalWeight: 225, sundayLock: true };
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
  try { s = STORE_KEY && JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { /* corrupt or blocked */ }
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
    reports: s.reports || {},
    places: Array.isArray(s.places) ? s.places : null, // places they eat, in their order (null = not asked yet)             // week start (Sunday) -> saved Claude coaching for that week
    profile: s.profile || null,           // age, sex, height, activity, goal from the setup
    needsSetup: fresh || !!s.needsSetup,  // brand-new phone: ask for their info before anything else
  };
  return st;
}
function save() {
  if (!STORE_KEY) return;
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

// Each day's log is split into Meal 1–5. New food goes to the meal you're on: the same one if you
// logged something in the last 90 minutes, otherwise the next one.
const MEALS = 5;
function defaultMeal() {
  const es = ((state.days[today] || {}).entries || []).filter(e => e.meal);
  if (!es.length) return 1;
  const last = es.reduce((a, b) => (b.t > a.t ? b : a));
  if (Date.now() - last.t < 90 * 60000) return last.meal;
  return Math.min(MEALS, Math.max(...es.map(e => e.meal)) + 1);
}
// Groups a day's entries by meal (oldest first within each). Entries from before meals existed go last.
function mealGroups(entries) {
  const groups = Array.from({ length: MEALS }, (_, i) => ({ meal: i + 1, entries: [] }));
  const other = { meal: 0, entries: [] };
  [...entries].sort((a, b) => (a.t || 0) - (b.t || 0))
    .forEach(e => (groups[e.meal - 1] || other).entries.push(e));
  return other.entries.length ? [...groups, other] : groups;
}
const sumOf = es => es.reduce((t, e) => ({ cal: t.cal + (+e.cal || 0), p: t.p + (+e.p || 0) }), { cal: 0, p: 0 });

function addEntry(data) {
  const e = { id: uid(), name: data.name, cal: data.cal, p: data.p, c: data.c, f: data.f, meal: data.meal || defaultMeal(), t: Date.now() };
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
function favoriteEntry(id) {
  const e = todayDay().entries.find(x => x.id === id);
  if (!e) return;
  const existed = state.favorites.some(f => f.name.toLowerCase() === e.name.toLowerCase());
  upsertFavorite(e);
  render();
  toast(existed ? `⭐ ${e.name} updated in favorites` : `⭐ Added ${e.name} to favorites`);
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
  const e = addEntry({ ...fav, meal: null });
  toast(`Logged ${fav.name} · Meal ${e.meal}`, 'Undo', () => {
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
  checkWeighin();
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
  $('#gap-open').hidden = !(calLeft > 0 && proLeft > 0);

  const favs = [...state.favorites].sort((a, b) => (b.uses || 0) - (a.uses || 0));
  $('#quick-wrap').hidden = !favs.length;
  $('#quick').innerHTML = favs.map(f => `<button class="chip" data-fav="${f.id}">+ ${esc(f.name)}</button>`).join('');

  const favNames = new Set(state.favorites.map(f => f.name.toLowerCase()));
  $('#log').innerHTML = mealGroups(has ? d.entries : []).map(({ meal, entries }) => {
    const sum = sumOf(entries);
    const head = `<div class="meal-head">
        <span class="meal-name">${meal ? 'Meal ' + meal : 'Unsorted'}</span>
        <span class="meal-sum">${entries.length ? `${fmt(sum.cal)} cal · P ${fmt(sum.p)}` : ''}</span>
        ${meal ? `<button class="meal-add" type="button" data-meal-add="${meal}" aria-label="Add food to Meal ${meal}">+</button>` : ''}
      </div>`;
    return `<div class="meal${entries.length ? '' : ' meal-empty'}">${head}${entries.map(e => {
      const isFav = favNames.has(e.name.toLowerCase());
      return `<div class="swipe" data-swipe="${e.id}">
          <div class="swipe-bg"><span class="swipe-fav">⭐ Favorite</span><span class="swipe-del">Delete 🗑</span></div>
          ${entryHTML(isFav ? { ...e, name: '⭐ ' + e.name } : e, `data-entry="${e.id}"`).replace('class="entry"', 'class="entry swipe-move"')}
        </div>`;
    }).join('')}</div>`;
  }).join('');
}

function renderFavs() {
  const favs = [...state.favorites].sort((a, b) => a.name.localeCompare(b.name));
  $('#favs').innerHTML = favs.length
    ? favs.map(f => `
        <div class="swipe swipe-tolist" data-swipe="${f.id}">
          <div class="swipe-bg"><span class="swipe-fav">🛒 Add to list</span><span class="swipe-del">Delete 🗑</span></div>
          <div class="fav-row swipe-move">
            ${entryHTML({ ...f, t: 0 }, `data-fav="${f.id}"`)}
            <button class="icon-btn" data-edit-fav="${f.id}" aria-label="Edit ${esc(f.name)}">✎</button>
          </div>
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

  // Weeks run Sunday → Saturday, newest week first; this week and last week start open.
  const weeks = [...new Set([weekStart(today), ...keys.map(weekStart)])].sort().reverse();
  $('#days').innerHTML = weeks.map((ws, i) => weekHTML(ws, i < 2)).join('');
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
  const groups = mealGroups(d.entries).filter(g => g.entries.length);
  const entries = groups.map(({ meal, entries: es }) => {
    const sum = sumOf(es);
    return (groups.length === 1 && !meal ? '' : `<div class="day-meal"><span>${meal ? 'Meal ' + meal : 'Unsorted'}</span><span>${fmt(sum.cal)} cal · P${fmt(sum.p)}</span></div>`) +
      es.map(e => `<div><span>${esc(e.name)}</span><span>${fmt(e.cal)} cal · P${fmt(e.p)} C${fmt(e.c)} F${fmt(e.f)}</span></div>`).join('');
  }).join('');
  return `
    <div class="swipe swipe-copy day-wrap" data-swipe="${k}">
      <div class="swipe-bg"><span class="swipe-fav">📋 Copy to today</span><span class="swipe-del">Delete day 🗑</span></div>
      <details class="day swipe-move">
        <summary><div class="day-head"><span>${dayLabel(k)}</span>${badge}</div><div class="bars">${bars}</div></summary>
        <div class="day-entries">${entries}</div>
      </details>
    </div>`;
}

/* ---- Weeks (Sunday → Saturday) ---- */
const weekStart = k => shiftKey(k, -parseKey(k).getDay());
const weekDays = ws => Array.from({ length: 7 }, (_, i) => shiftKey(ws, i));
const shortDate = k => parseKey(k).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const weekRange = ws => `${shortDate(ws)} – ${shortDate(shiftKey(ws, 6))}`;
function weekName(ws) {
  const cur = weekStart(today);
  return ws === cur ? 'This week' : ws === shiftKey(cur, -7) ? 'Last week' : `Week of ${shortDate(ws)}`;
}
// Latest weigh-in on or before a day.
function weightOnOrBefore(k) {
  const ws = sortedWeights().filter(w => w.k <= k);
  return ws.length ? ws[ws.length - 1] : null;
}
function weekStats(ws) {
  const days = weekDays(ws);
  const logged = days.filter(k => state.days[k] && state.days[k].entries.length);
  const tot = logged.map(totals);
  const avg = {};
  for (const m of ['cal', 'p', 'c', 'f']) avg[m] = logged.length ? tot.reduce((s, t) => s + t[m], 0) / logged.length : 0;
  const g = logged.length ? targetsFor(logged[logged.length - 1]) : state.settings;
  const over = logged.filter(k => totals(k).cal > targetsFor(k).cal);
  const short = logged.filter(k => totals(k).p < targetsFor(k).protein && k !== today);
  // The weigh-in that closes the week is the next Sunday's; it's compared with the one that opened it.
  const end = shiftKey(ws, 7) <= today ? shiftKey(ws, 7) : today;
  const wEnd = weightOnOrBefore(end), wStart = weightOnOrBefore(shiftKey(ws, 0));
  const change = wEnd && wStart && wEnd.k !== wStart.k ? wEnd.w - wStart.w : null;
  const done = shiftKey(ws, 6) < today;
  return { ws, days, logged, avg, g, hits: logged.filter(isHit).length, over, short, wEnd, wStart, change, done };
}
function weekHTML(ws, open) {
  const st = weekStats(ws);
  const sub = st.logged.length
    ? `${st.hits}/${st.logged.length} hit · avg ${fmt(st.avg.cal)} cal · P ${fmt(st.avg.p)} g`
    : 'Nothing logged';
  const w = st.wEnd && st.wEnd.k >= ws
    ? ` · ⚖️ ${fmt1(st.wEnd.w)}${st.change != null ? ` (${st.change > 0 ? '+' : ''}${fmt1(st.change)})` : ''}` : '';
  const rows = st.days.map(k => state.days[k] && state.days[k].entries.length ? dayHTML(k)
    : `<div class="day-empty${k > today ? ' future' : ''}"><span>${dayLabel(k)}</span><span>${k > today ? '' : 'Nothing logged'}</span></div>`).join('');
  const report = st.logged.length
    ? `<button class="btn block week-report" type="button" data-report="${ws}">📊 ${st.done ? 'Weekly report' : 'Week so far'}</button>` : '';
  return `
    <details class="week"${open ? ' open' : ''}>
      <summary class="week-head">
        <div class="week-title"><b>${weekName(ws)}</b><span>${weekRange(ws)}</span></div>
        <div class="week-sub">${sub}${w}</div>
      </summary>
      ${report}${rows}
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
  const favNames = new Set(state.favorites.map(f => f.name.toLowerCase()));
  const row = i => `
    <div class="swipe" data-swipe="${i.id}">
      <div class="swipe-bg"><span class="swipe-fav">⭐ Favorite</span><span class="swipe-del">Delete 🗑</span></div>
      <div class="shop-row swipe-move ${i.done ? 'done' : ''}">
        <button class="shop-item" data-shop="${i.id}"><span class="box">✓</span><span class="shop-name">${favNames.has(i.name.toLowerCase()) ? '⭐ ' : ''}${esc(i.name)}</span>${i.qty ? `<span class="shop-qty">${esc(i.qty)}</span>` : ''}</button>
        <button class="icon-btn" data-edit-shop="${i.id}" aria-label="Edit ${esc(i.name)}">✎</button>
      </div>
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
function deleteShopItem(id) {
  const i = state.shopping.findIndex(x => x.id === id);
  if (i < 0) return;
  const [removed] = state.shopping.splice(i, 1);
  save(); render();
  toast(`Removed ${removed.name}`, 'Undo', () => { state.shopping.splice(i, 0, removed); save(); render(); });
}
// Saves a list item as a favorite. Uses nutrition we already know (scanned barcode or the
// school menu); otherwise opens the New favorite form with the name filled in.
function favoriteShopItem(id) {
  const it = state.shopping.find(x => x.id === id);
  if (!it) return;
  const name = it.name.toLowerCase();
  if (state.favorites.some(f => f.name.toLowerCase() === name)) { toast(`⭐ ${it.name} is already a favorite`); return; }
  const known = (it.code && state.barcodes[it.code]) || cafeteria.find(c => c.name.toLowerCase() === name);
  if (known && (known.cal != null || known.p != null)) {
    upsertFavorite({ name: it.name, cal: known.cal || 0, p: known.p || 0, c: known.c || 0, f: known.f || 0 });
    render();
    toast(`⭐ Added ${it.name} to favorites`);
    return;
  }
  openSheet('fav', null, { name: it.name });
  scanNote('Enter the nutrition for 1 serving to save it as a favorite.');
}
$('#it-delete').addEventListener('click', () => {
  const id = itemId;
  closeItemSheet();
  deleteShopItem(id);
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
  $('#app-version').textContent = APP_VERSION;
  $('#s-cal').value = s.cal; $('#s-protein').value = s.protein;
  $('#s-carbs').value = s.carbs; $('#s-fat').value = s.fat;
  $('#s-weight').value = s.weight; $('#s-goal').value = s.goalWeight;
  $('#s-sunday').checked = s.sundayLock !== false;
  renderAiSettings();
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

function openSheet(mode, item, prefill, meal) {
  sheet = { mode, id: item && item.id };
  $('#meal-row').hidden = mode === 'fav';
  setSheetMeal(mode === 'entry' ? item && item.meal : mode === 'add' ? meal || defaultMeal() : null);
  const src = item || prefill;
  $('#sheet-title').textContent =
    mode === 'add' ? 'Log food' : mode === 'entry' ? 'Edit entry' : item ? 'Edit favorite' : 'New favorite';
  $('#sheet-save').textContent = mode === 'add' ? 'Log it' : 'Save';
  $('#sheet-save').disabled = false;
  $('#in-name').value = src ? src.name : '';
  IN.forEach(k => { $('#in-' + k).value = src && src[k] != null ? +(+src[k]).toFixed(1) : ''; });
  $('#fav-row').hidden = mode === 'fav';
  $('#in-fav').checked = false;
  $('#sheet-delete').hidden = !item;
  $('#backdrop').hidden = false;
  resetScanState();
  $('#capture-row').hidden = mode === 'entry';
  if (!item) (prefill ? $('#in-cal') : $('#in-name')).focus();
}
function setSheetMeal(m) {
  if (sheet) sheet.meal = m || null;
  document.querySelectorAll('#meal-seg button').forEach(b => b.classList.toggle('on', +b.dataset.meal === m));
}
$('#meal-seg').addEventListener('click', ev => {
  const b = ev.target.closest('button[data-meal]');
  if (b) setSheetMeal(+b.dataset.meal);
});
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

// Typed a meal in the Food box but no numbers? Estimate it instead of logging zeros.
function needsEstimate() {
  if (!sheet || !$('#in-name').value.trim()) return false;
  return IN.every(k => $('#in-' + k).value.trim() === '');
}
function updateSaveLabel() {
  if (!sheet) return;
  const estimate = needsEstimate() && getAiKey();
  $('#sheet-save').textContent = estimate ? '✍️ Estimate macros' : sheet.mode === 'add' ? 'Log it' : 'Save';
}
$('#entry-form').addEventListener('input', updateSaveLabel);

$('#entry-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  if (needsEstimate()) {
    if (!getAiKey()) {
      scanNote('Enter the calories or macros, or use 📷 Barcode, 📸 Photo or ✍️ Describe. (Photo and Describe need your API key in Settings.)');
      $('#in-cal').focus();
      return;
    }
    $('#in-name').blur();
    const save = $('#sheet-save');
    save.disabled = true; save.textContent = 'Estimating…';
    photoData = null;
    $('#photo-note').value = $('#in-name').value.trim();
    await estimatePhoto();
    save.disabled = false;
    updateSaveLabel();
    return;
  }
  const data = readForm();
  if (!data) { $('#in-name').focus(); return; }
  const { mode, id, code } = sheet;
  if (sheet.meal) data.meal = sheet.meal;
  const asFav = $('#in-fav').checked;
  if (code) rememberBarcode(code, data);
  if (perServing && servings !== 1) data.name = `${data.name} ×${servings}`;
  closeSheet();
  if (mode === 'add') {
    const e = addEntry(data);
    if (asFav) upsertFavorite(data);
    toast(`Logged ${data.name} · Meal ${e.meal}${asFav ? ' ★' : ''}`);
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
  if (mode === 'fav') deleteFavorite(id);
});
function deleteFavorite(id) {
  const i = state.favorites.findIndex(f => f.id === id);
  if (i < 0) return;
  const [removed] = state.favorites.splice(i, 1);
  save(); render();
  toast(`Deleted ${removed.name}`, 'Undo', () => { state.favorites.splice(i, 0, removed); save(); render(); });
}
function favoriteToList(id) {
  const fav = state.favorites.find(f => f.id === id);
  if (!fav) return;
  const added = addShopItem(fav.name, '');
  save(); render();
  toast(added ? `🛒 Added ${fav.name} to your list` : `🛒 ${fav.name} is already on your list`);
}
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
  photoData = null;
  $('#photo-panel').hidden = true;
  $('#suggest').hidden = true;
  $('#serving-row').hidden = true;
  $('#scan-note').hidden = true;
  $('#in-servings').value = 1;
  updateSaveLabel();
}
function setServings(v, fromInput) {
  if (!(v > 0) || !perServing) { updateSaveLabel(); return; }
  servings = Math.round(v * 100) / 100;
  if (!fromInput) $('#in-servings').value = servings;
  IN.forEach(k => {
    const base = perServing[k];
    $('#in-' + k).value = base == null ? '' : +(base * servings).toFixed(k === 'cal' ? 0 : 1);
  });
  updateSaveLabel();
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
let cafeteria = [], menusLoaded = false;
async function loadCafeteria() {
  try {
    const res = await fetch('cafeteria.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const data = await res.json();
    cafeteria = (data.items || []).filter(i => i.cal != null || i.p != null);
  } catch (e) { /* offline and never loaded: just no school suggestions */ }
  await loadRestaurants();
  menusLoaded = true;
  maybeAutoReport();
}

// restaurants.json is refreshed weekly from each chain's official nutrition info by a GitHub Action.
let restaurants = [], chainList = [];
const norm = s => String(s || '').toLowerCase().replace(/[’'`.-]/g, '').replace(/\s+/g, ' ');
async function loadRestaurants() {
  try {
    const res = await fetch('restaurants.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const data = await res.json();
    chainList = Object.values(data.chains || {}).map(ch => ({
      name: ch.name, keys: [ch.name, ...(ch.aliases || [])].map(norm).filter(Boolean),
    }));
    restaurants = Object.values(data.chains || {}).flatMap(ch => (ch.items || [])
      .filter(i => i.cal != null || i.p != null)
      .map(i => {
        const full = norm(i.name).startsWith(norm(ch.name)) ? i.name : `${ch.name} ${i.name}`;
        const chainHay = norm(`${ch.name} ${(ch.aliases || []).join(' ')}`);
        return { ...i, name: full, short: i.name, chain: ch.name, chainHay, hay: norm(`${full} ${chainHay}`) };
      }));
  } catch (e) { /* no restaurant suggestions */ }
}

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Favorites first, then your scanned barcodes, then the school menu. Every typed word must match.
function suggestions(query) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const words = q.split(/\s+/), nwords = norm(q).split(' ').filter(Boolean);
  const pool = [
    ...state.favorites.map(f => ({ ...f, src: 'fav' })),
    ...Object.entries(state.barcodes).map(([code, b]) => ({ ...b, code, src: 'scan' })),
    ...cafeteria.map(i => ({ ...i, src: 'school' })),
    ...restaurants.map(i => ({ ...i, src: 'rest' })),
  ];
  const seen = new Set(), out = [];
  for (const it of pool) {
    const name = (it.name || '').toLowerCase();
    const hay = it.hay || norm(it.name);
    if (!name || seen.has(name) || !nwords.every(w => hay.includes(w))) continue;
    seen.add(name);
    // Rank on the item's own name; words that only name the chain ("cfa", "dunkin") just filter.
    const target = norm(it.short || it.name);
    const qw = it.chainHay ? nwords.filter(w => !it.chainHay.includes(w) || target.includes(w)) : nwords;
    const qs = qw.join(' ');
    const where = !qs ? 1 : target.startsWith(qs) ? 0 : new RegExp('\\b' + escRe(qw[0])).test(target) ? 1 : 2;
    out.push({ it, score: where + { fav: 0, scan: 0.1, school: 0.2, rest: 0.3 }[it.src] + target.length / 200 + (nwords.length - qw.length) * 0.15 });
  }
  return out.sort((a, b) => a.score - b.score || a.it.name.localeCompare(b.it.name)).slice(0, 6).map(x => x.it);
}

let suggestList = [];
function showSuggest() {
  suggestList = suggestions($('#in-name').value);
  const icon = { fav: '⭐', scan: '📷', school: '🏫', rest: '🍔' };
  $('#suggest').innerHTML = suggestList.map((it, i) => {
    const meta = [it.cal != null ? `${fmt(it.cal)} cal` : '', it.p != null ? `P ${fmt1(it.p)}` : '', it.serving ? esc(it.serving) : '']
      .filter(Boolean).join(' · ');
    return `<button type="button" class="sug" data-sug="${i}"><span class="sug-name">${esc(it.short || it.name)}</span><span class="sug-meta">${it.src === 'rest' && it.chain ? placeIcon(it.chain) : icon[it.src]} ${it.chain ? esc(it.chain) + ' · ' : ''}${meta}</span></button>`;
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
  scanNote(it.src === 'school' ? '🏫 From the NPHS cafeteria menu' : it.src === 'rest' ? `🍔 From ${it.chain}'s official nutrition info${it.carbsEstimated ? ' (carbs estimated)' : ''}` : '');
});

/* ================= Setup / macro calculator ================= */

const ACTIVITY = [
  { id: 'sedentary', f: 1.2,   label: 'Mostly sitting',  sub: 'Little or no exercise' },
  { id: 'light',     f: 1.375, label: 'Lightly active',  sub: 'Exercise 1–3 days a week' },
  { id: 'moderate',  f: 1.55,  label: 'Active',          sub: 'Workouts or practice 3–5 days a week' },
  { id: 'very',      f: 1.725, label: 'Very active',     sub: 'Hard training 6–7 days, or a sport in season' },
];
$('#su-activity').innerHTML = ACTIVITY.map(a => `<button type="button" data-v="${a.id}">${a.label}<small>${a.sub}</small></button>`).join('');

// Mifflin-St Jeor estimate of daily burn, then adjusted for the goal.
// Under 18 the cut is kept small and calories have a higher floor.
function calcTargets(pr) {
  const teen = pr.age < 18;
  const kg = pr.weight * 0.4536, cm = pr.heightIn * 2.54;
  const bmr = 10 * kg + 6.25 * cm - 5 * pr.age + (pr.sex === 'm' ? 5 : -161);
  const tdee = bmr * ACTIVITY.find(a => a.id === pr.activity).f;
  const adj = pr.goal === 'lose' ? (teen ? -0.10 : -0.20) : pr.goal === 'gain' ? 0.10 : 0;
  let cal = tdee * (1 + adj);
  if (pr.goal === 'lose') {
    const floor = teen ? (pr.sex === 'm' ? 2000 : 1800) : (pr.sex === 'm' ? 1500 : 1200);
    cal = Math.max(cal, Math.min(floor, tdee));
  }
  cal = Math.round(cal / 10) * 10;
  const r5 = v => Math.round(v / 5) * 5;
  // Protein: ~1 g per lb of goal weight for adults cutting or building, 0.8 g per lb otherwise.
  const perLb = !teen && pr.goal !== 'maintain' ? 1.0 : 0.8;
  const basis = !teen && pr.goal === 'lose' ? Math.min(pr.weight, pr.goalWeight || pr.weight) : pr.weight;
  const protein = Math.min(r5(perLb * basis), r5(cal * 0.35 / 4));
  const fat = r5(cal * (teen ? 0.30 : 0.25) / 9);
  const carbs = Math.max(0, r5((cal - protein * 4 - fat * 9) / 4));
  return { cal, protein, carbs, fat, tdee: Math.round(tdee / 10) * 10, adj, teen };
}

let setupPick = {}, goalTouched = false, setupFirstRun = false;
function paintSeg(id, value) {
  setupPick[id] = value;
  document.querySelectorAll(`#${id} button`).forEach(b => b.classList.toggle('on', b.dataset.v === value));
}
['su-sex', 'su-activity', 'su-goal'].forEach(id => $('#' + id).addEventListener('click', ev => {
  const b = ev.target.closest('button[data-v]');
  if (!b) return;
  if (id === 'su-goal') goalTouched = true;
  paintSeg(id, b.dataset.v);
  updateSetup();
}));

function readProfile() {
  const n = id => parseFloat($('#' + id).value);
  const pr = {
    age: n('su-age'), sex: setupPick['su-sex'], heightIn: (n('su-ft') || 0) * 12 + (n('su-in') || 0),
    weight: n('su-weight'), goalWeight: n('su-goalw'), activity: setupPick['su-activity'], goal: setupPick['su-goal'],
  };
  const ok = pr.age >= 13 && pr.age <= 100 && pr.sex && pr.heightIn >= 48 && pr.weight >= 60 && pr.goalWeight >= 60 && pr.activity && pr.goal;
  return ok ? pr : null;
}
function updateSetup() {
  // Pick the goal from the two weights until they choose one themselves.
  const w = parseFloat($('#su-weight').value), g = parseFloat($('#su-goalw').value);
  if (!goalTouched && w > 0 && g > 0) paintSeg('su-goal', g < w - 1 ? 'lose' : g > w + 1 ? 'gain' : 'maintain');
  const pr = readProfile();
  $('#su-results').hidden = !pr;
  $('#su-missing').hidden = !!pr;
  $('#su-save').disabled = !pr;
  if (!pr) return;
  const t = calcTargets(pr);
  $('#su-cal').value = t.cal; $('#su-p').value = t.protein; $('#su-c').value = t.carbs; $('#su-f').value = t.fat;
  const pct = Math.round(Math.abs(t.adj) * 100);
  $('#su-explain').textContent = `You burn about ${fmt(t.tdee)} calories a day. ` + (
    pr.goal === 'lose' ? `This target is about ${pct}% under that${t.teen ? ', a gentle cut' : ''}, to lose fat while keeping muscle.`
    : pr.goal === 'gain' ? `This target is about ${pct}% over that, to build muscle without much fat gain.`
    : 'This target matches it, to hold your weight steady.');
  $('#su-teen').hidden = !t.teen;
}
// Typing in the top section recalculates; editing a result box keeps your number.
['su-age', 'su-ft', 'su-in', 'su-weight', 'su-goalw'].forEach(id => $('#' + id).addEventListener('input', updateSetup));

function openSetup(firstRun) {
  setupFirstRun = firstRun;
  const pr = state.profile || {}, s = state.settings;
  $('#setup-title').textContent = firstRun ? "Welcome! Let's set your targets." : 'Calculate my targets';
  $('#su-cancel').hidden = firstRun;
  $('#su-age').value = pr.age || '';
  $('#su-ft').value = pr.heightIn ? Math.floor(pr.heightIn / 12) : '';
  $('#su-in').value = pr.heightIn ? Math.round(pr.heightIn % 12) : '';
  $('#su-weight').value = firstRun ? '' : s.weight;
  $('#su-goalw').value = firstRun ? '' : s.goalWeight;
  setupPick = {};
  paintSeg('su-sex', pr.sex); paintSeg('su-activity', pr.activity); paintSeg('su-goal', pr.goal);
  goalTouched = !!pr.goal;
  updateSetup();
  $('#setup').hidden = false;
  $('#setup').scrollTop = 0;
}
$('#su-cancel').addEventListener('click', () => { $('#setup').hidden = true; });
$('#recalc-btn').addEventListener('click', () => openSetup(false));

$('#setup-form').addEventListener('submit', ev => {
  ev.preventDefault();
  const pr = readProfile();
  if (!pr) return;
  const v = id => Math.max(0, Math.round(parseFloat($('#' + id).value) || 0));
  const t = calcTargets(pr);
  Object.assign(state.settings, {
    cal: v('su-cal') || t.cal, protein: v('su-p'), carbs: v('su-c'), fat: v('su-f'),
    goalWeight: pr.goalWeight,
  });
  // Record the weight as today's weigh-in if it's new.
  const latest = sortedWeights().pop();
  if (!latest || latest.w !== pr.weight) state.weights[today] = Math.round(pr.weight * 10) / 10;
  syncCurrentWeight();
  state.profile = { age: pr.age, sex: pr.sex, heightIn: pr.heightIn, activity: pr.activity, goal: pr.goal };
  state.needsSetup = false;
  if (state.days[today]) todayDay();
  save();
  $('#setup').hidden = true;
  render();
  toast(setupFirstRun ? 'Targets set. Mission start! 🎯' : 'Targets updated');
});

/* ================= Swipe actions ================= */
// Swipe left = delete (with Undo), swipe right = save as favorite. Taps keep their normal action.
function makeSwipeable(container, { onLeft, onRight }) {
  let sw = null, swallowClick = false;
  container.addEventListener('pointerdown', ev => {
    const row = ev.target.closest('.swipe');
    if (!row || ev.button > 0) return;
    sw = { row, el: row.querySelector('.swipe-move'), x: ev.clientX, y: ev.clientY, dx: 0, active: false, armed: false, pid: ev.pointerId };
  });
  container.addEventListener('pointermove', ev => {
    if (!sw || ev.pointerId !== sw.pid) return;
    const dx = ev.clientX - sw.x, dy = ev.clientY - sw.y;
    if (!sw.active) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { sw = null; return; } // it's a scroll
      if (Math.abs(dx) < 10) return;
      sw.active = true;
      try { sw.el.setPointerCapture(ev.pointerId); } catch (e) { /* fine without */ }
      sw.el.classList.remove('snap');
    }
    sw.dx = dx;
    sw.el.style.transform = `translateX(${dx}px)`;
    sw.row.dataset.dir = dx < 0 ? 'left' : 'right';
    const armed = Math.abs(dx) > Math.min(110, sw.row.offsetWidth * 0.3);
    if (armed !== sw.armed) {
      sw.armed = armed;
      sw.row.classList.toggle('armed', armed);
      if (armed && navigator.vibrate) navigator.vibrate(10);
    }
  });
  const end = ev => {
    if (!sw) return;
    const s = sw;
    sw = null;
    if (!s.active) return;
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 60);
    const id = s.row.dataset.swipe, go = s.armed && ev.type !== 'pointercancel';
    s.el.classList.add('snap');
    if (go && s.dx < 0) {
      s.el.style.transform = 'translateX(-110%)';
      setTimeout(() => onLeft(id), 180);
      return;
    }
    s.el.style.transform = '';
    s.row.classList.remove('armed');
    setTimeout(() => { delete s.row.dataset.dir; }, 200);
    if (go) onRight(id);
  };
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);
  // A swipe shouldn't also count as a tap.
  container.addEventListener('click', ev => { if (swallowClick) { ev.stopPropagation(); ev.preventDefault(); } }, true);
}
makeSwipeable($('#log'), { onLeft: deleteEntry, onRight: favoriteEntry });
makeSwipeable($('#view-list'), { onLeft: deleteShopItem, onRight: favoriteShopItem });
makeSwipeable($('#favs'), { onLeft: deleteFavorite, onRight: favoriteToList });
makeSwipeable($('#days'), { onLeft: deleteDay, onRight: copyDayToToday });

function deleteDay(k) {
  const removed = state.days[k];
  if (!removed) return;
  const label = dayLabel(k);
  delete state.days[k];
  save(); render();
  toast(`Deleted ${label}`, 'Undo', () => { state.days[k] = removed; save(); render(); });
}
// Re-logs everything from a past day into today (handy for repeat meal-prep days).
function copyDayToToday(k) {
  if (k === today) { toast("That's today's log"); return; }
  const src = state.days[k];
  if (!src || !src.entries.length) return;
  const now = Date.now();
  const copies = src.entries.map((e, i) => ({ ...e, id: uid(), t: now + i }));
  todayDay().entries.push(...copies);
  save(); render(); checkHoorah();
  const ids = new Set(copies.map(c => c.id));
  toast(`📋 Copied ${copies.length} item${copies.length === 1 ? '' : 's'} to today`, 'Undo', () => {
    const d = todayDay();
    d.entries = d.entries.filter(e => !ids.has(e.id));
    save(); render();
  });
}

/* ================= Photo estimates (Claude) ================= */
// The API key lives in its own storage slot so it never ends up in an exported backup.
const AI_KEY_SLOT = account ? `${LEGACY_AI_KEY}:${account.id}` : LEGACY_AI_KEY;
const AI_MODEL = 'claude-opus-5-5';
const getAiKey = () => { try { return localStorage.getItem(AI_KEY_SLOT) || ''; } catch (e) { return ''; } };
let photoData = null; // base64 JPEG of the chosen photo

function renderAiSettings() {
  if (typeof renderAccount === 'function') renderAccount();
  if (typeof renderMyPlaces === 'function') renderMyPlaces();
  const key = getAiKey();
  $('#ai-status').textContent = key ? `✅ Key saved on this phone (…${key.slice(-4)})` : 'No key yet. Photo and Describe estimates are off.';
  $('#ai-remove').hidden = !key;
}
$('#ai-form').addEventListener('submit', ev => {
  ev.preventDefault();
  const key = $('#ai-key').value.trim();
  if (!/^sk-ant-/.test(key)) { toast("That doesn't look like an Anthropic key (it starts with sk-ant-)"); return; }
  try { localStorage.setItem(AI_KEY_SLOT, key); } catch (e) { toast('Could not save the key on this phone'); return; }
  $('#ai-key').value = ''; $('#ai-key').blur();
  renderAiSettings();
  toast('Key saved. Photo estimates are on 📸');
});
$('#ai-remove').addEventListener('click', () => {
  if (!confirm('Remove your Anthropic key from this phone?')) return;
  try { localStorage.removeItem(AI_KEY_SLOT); } catch (e) { /* ignore */ }
  renderAiSettings();
  toast('Key removed');
});

// Shrink the photo before sending: faster upload, lower cost, plenty of detail for food.
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't read that photo. Try another one."));
    img.src = URL.createObjectURL(file);
  });
}
async function photoToJpeg(file, max = 1024) {
  const img = await loadImage(file);
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(img.src);
  return canvas.toDataURL('image/jpeg', 0.8);
}

$('#photo-food').addEventListener('click', () => {
  if (!getAiKey()) { scanNote('📸 Add your Anthropic API key in Settings → Photo estimates to turn this on.'); return; }
  $('#photo-input').value = '';
  $('#photo-input').click();
});
$('#photo-input').addEventListener('change', async () => {
  const file = $('#photo-input').files[0];
  $('#photo-input').value = ''; // so picking the same photo again still counts
  if (!file || !sheet) return;
  try {
    const url = await photoToJpeg(file);
    photoData = url.split(',')[1];
    $('#photo-preview').src = url;
    $('#photo-preview').hidden = false;
    $('#photo-note').value = '';
    $('#photo-note').placeholder = 'Optional: e.g. 8 oz chicken, 1 cup rice';
    $('#photo-panel').hidden = false;
    scanNote('Add a note about portions if you like, then tap Estimate.');
  } catch (e) { scanNote(e.message); }
});
// Describe a meal in words instead of a photo.
$('#describe-food').addEventListener('click', () => {
  if (!getAiKey()) { scanNote('✍️ Add your Anthropic API key in Settings → Photo estimates to turn this on.'); return; }
  photoData = null;
  $('#photo-preview').hidden = true;
  $('#photo-note').value = '';
  $('#photo-note').placeholder = 'e.g. 6 oz steak, 2 slices provolone, 1 torpedo roll';
  $('#photo-panel').hidden = false;
  scanNote('Describe what you ate, with amounts if you know them, then tap Estimate.');
  $('#photo-note').focus();
});
$('#photo-cancel').addEventListener('click', () => { photoData = null; $('#photo-panel').hidden = true; scanNote(''); });
$('#photo-go').addEventListener('click', estimatePhoto);

const ESTIMATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['name', 'items', 'total', 'confidence', 'notes'],
  properties: {
    name: { type: 'string', description: 'Short name for the meal, e.g. "Grilled chicken, rice and broccoli"' },
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['food', 'portion', 'cal', 'p', 'c', 'f'],
        properties: {
          food: { type: 'string' }, portion: { type: 'string', description: 'Estimated amount, e.g. "6 oz" or "1 cup"' },
          cal: { type: 'number' }, p: { type: 'number' }, c: { type: 'number' }, f: { type: 'number' },
        },
      },
    },
    total: {
      type: 'object', additionalProperties: false, required: ['cal', 'p', 'c', 'f'],
      properties: { cal: { type: 'number' }, p: { type: 'number' }, c: { type: 'number' }, f: { type: 'number' } },
    },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    notes: { type: 'string', description: 'One short sentence on assumptions, e.g. hidden oil or sauce' },
  },
};
const ESTIMATE_SYSTEM = 'You estimate nutrition from meal photos or written descriptions for a personal macro tracker. Identify each food, ' +
  'estimate its portion from visual cues (plate size, utensils, hands, packaging), and give calories plus protein, ' +
  'carbs and fat in grams for everything shown. Assume typical preparation, including visible oil, butter and sauces. ' +
  'If the user gives portions or ingredients in words, use them exactly and trust them over the photo; for a written ' +
  'description with no amount, assume one typical serving. If there is no food to estimate, ' +
  'return zeros, set confidence to low, and say so in notes.';

// Calls go straight from this phone to Anthropic with the user's own key; there is no server in between.
async function aiClient() {
  await loadScript('vendor/anthropic-sdk.js');
  const { Anthropic } = window.AnthropicSDK;
  return new Anthropic({ apiKey: getAiKey(), dangerouslyAllowBrowser: true, maxRetries: 1 });
}

async function estimatePhoto() {
  const note = $('#photo-note').value.trim();
  if (!sheet || (!photoData && !note)) { $('#photo-note').focus(); return; }
  const fromPhoto = !!photoData;
  const btn = $('#photo-go');
  btn.disabled = true; btn.textContent = 'Estimating…';
  scanNote(fromPhoto ? '📸 Looking at your food… this takes a few seconds.' : '✍️ Working out the macros… this takes a few seconds.');
  try {
    const client = await aiClient();
    const res = await client.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: ESTIMATE_SCHEMA } },
      system: ESTIMATE_SYSTEM,
      messages: [{
        role: 'user',
        content: fromPhoto ? [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photoData } },
          { type: 'text', text: note ? `Estimate the macros for this meal. Note from me: ${note}` : 'Estimate the macros for this meal.' },
        ] : [
          { type: 'text', text: `Estimate the macros for this meal: ${note}` },
        ],
      }],
    });
    if (res.stop_reason === 'refusal') throw new Error('refused');
    const block = res.content.find(b => b.type === 'text');
    if (!block) throw new Error('empty');
    applyEstimate(JSON.parse(block.text), fromPhoto);
  } catch (e) {
    scanNote(aiErrorMessage(e));
  } finally {
    btn.disabled = false; btn.textContent = 'Estimate';
  }
}

function applyEstimate(est, fromPhoto) {
  if (!sheet) return; // form was closed while waiting
  const r = (v, d) => Math.round((+v || 0) * d) / d;
  $('#in-name').value = est.name || 'Photo meal';
  sheet.code = null;
  perServing = { cal: r(est.total.cal, 1), p: r(est.total.p, 10), c: r(est.total.c, 10), f: r(est.total.f, 10) };
  setServings(1);
  $('#serving-row').hidden = false;
  $('#serving-info').textContent = fromPhoto ? '1 serving = what is in the photo' : '1 serving = what you described';
  $('#photo-panel').hidden = true;
  const items = (est.items || []).map(i => `${i.food} (${i.portion})`).join(' · ');
  scanNote(`${fromPhoto ? '📸' : '✍️'} AI estimate, ${est.confidence} confidence: ${items}${est.notes ? '. ' + est.notes : ''} Check the numbers before logging.`);
}

// Most specific first: key problems, billing, rate limits, then connection, then anything else from the API.
function aiErrorMessage(e) {
  const A = window.AnthropicSDK && window.AnthropicSDK.Anthropic;
  if (A) {
    if (e instanceof A.AuthenticationError) return "🔑 Your API key wasn't accepted. Check it in Settings → Photo estimates.";
    if (e instanceof A.PermissionDeniedError) return '🔑 That key does not have permission to use this model.';
    if (e instanceof A.RateLimitError) return 'Too many requests right now. Wait a minute and try again.';
    if (e instanceof A.BadRequestError) {
      return /credit balance/i.test(e.message)
        ? '💳 Your Anthropic account is out of credit. Add some at console.anthropic.com → Billing.'
        : `The request was rejected: ${String(e.message).slice(0, 160)}`;
    }
    if (e instanceof A.APIConnectionError) return "Couldn't reach Anthropic. Check your internet connection.";
    if (e instanceof A.APIError) return `Anthropic had a problem (${e.status}). Try again in a moment.`;
  }
  if (e && e.message === 'refused') return "The AI couldn't estimate this photo. Enter it by hand.";
  if (e instanceof SyntaxError || (e && e.message === 'empty')) return 'Got an unreadable answer. Try again.';
  return (e && e.message) || 'Something went wrong. Try again.';
}

/* ================= Sunday weigh-in lock ================= */
// On Sundays the app stays locked until today's weight is entered.
function weighinDue() {
  return state.settings.sundayLock !== false && !state.needsSetup &&
    parseKey(today).getDay() === 0 && state.weights[today] == null;
}
function checkWeighin() {
  const due = weighinDue();
  $('#weighin').hidden = !due;
  if (!due) { maybeAutoReport(); return; }
  const last = sortedWeights().pop();
  $('#weighin-last').textContent = last ? `Last weigh-in: ${fmt1(last.w)} lbs (${dayLabel(last.k)})` : '';
}
$('#weighin-form').addEventListener('submit', ev => {
  ev.preventDefault();
  const w = parseFloat($('#weighin-input').value);
  if (!(w >= 50 && w <= 1000)) { $('#weighin-input').focus(); return; }
  const prev = sortedWeights().pop();
  state.weights[today] = Math.round(w * 10) / 10;
  syncCurrentWeight();
  save();
  $('#weighin-input').value = ''; $('#weighin-input').blur();
  render();
  const diff = prev ? Math.round((w - prev.w) * 10) / 10 : 0;
  const toGo = Math.round((w - state.settings.goalWeight) * 10) / 10;
  const change = !prev ? 'Weigh-in logged' : diff < 0 ? `Down ${fmt1(-diff)} lbs since last weigh-in 💪` : diff > 0 ? `Up ${fmt1(diff)} lbs since last weigh-in` : 'Same as last weigh-in';
  toast(toGo > 0 ? `${change} · ${fmt1(toGo)} to go` : `${change} · Goal reached 🎯`);
  // render() above opens the report for the week that just ended (see maybeAutoReport).
});

/* ================= What should I eat? ================= */

function remaining() {
  const t = totals(today), g = state.settings;
  return { cal: g.cal - t.cal, p: g.protein - t.p, c: g.carbs - t.c, f: g.fat - t.f };
}

// Rank the foods we already know (favorites, scans, restaurants, school menu) by how well one
// serving closes the gap: protein shortfall and going over calories/carbs/fat both count against it.
// How many times each food has been logged (by name, ignoring "×2"), for "you've had this before".
function eatenCounts() {
  const c = {};
  for (const d of Object.values(state.days)) for (const e of d.entries) {
    const k = norm(baseName(e.name));
    c[k] = (c[k] || 0) + 1;
  }
  return c;
}

/* ---- Where are you? Orders from one place's menu ---- */
const SCHOOL = 'North Providence High School';
const placeName = pl => pl === SCHOOL ? 'North Providence High' : pl;
// Each restaurant's own logo (its site icon, via Google's public favicon service). Falls back to 🍔
// when it can't load, e.g. offline.
const PLACE_DOMAINS = {
  'Chick-fil-A': 'chick-fil-a.com', "Dunkin'": 'dunkindonuts.com', "McDonald's": 'mcdonalds.com', 'Subway': 'subway.com',
  "Wendy's": 'wendys.com', 'Tropical Smoothie Cafe': 'tropicalsmoothiecafe.com', 'Five Guys': 'fiveguys.com',
  "Chili's": 'chilis.com', 'Burger King': 'bk.com', "Raising Cane's": 'raisingcanes.com', 'Chipotle': 'chipotle.com',
};
function placeIcon(pl) {
  if (pl === SCHOOL) return '<span class="logo-emoji">🏫</span>';
  const d = PLACE_DOMAINS[pl];
  if (!d) return '<span class="logo-emoji">🍔</span>';
  return `<img class="logo" src="https://www.google.com/s2/favicons?domain=${d}&amp;sz=64" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;logo-emoji&quot;>🍔</span>'">`;
}
const placeHTML = pl => `${placeIcon(pl)} ${esc(placeName(pl))}`;
let gapPlace = null; // null = anywhere
function placeItems(place) {
  if (place === SCHOOL) return cafeteria.map(i => ({ ...i, short: i.name, name: i.name, src: 'school' }));
  return restaurants.filter(r => r.chain === place).map(i => ({ ...i, src: 'rest' }));
}
const allPlaces = () => [...(cafeteria.length ? [SCHOOL] : []), ...chainList.map(c => c.name).sort((a, b) => a.localeCompare(b))];
// Your places first (in the order you picked them), then the rest by how often you've been (last 60 days).
function gapPlaces() {
  const visits = {};
  const since = shiftKey(today, -60);
  for (const [k, d] of Object.entries(state.days)) if (k >= since) for (const e of d.entries) {
    const pl = placeOf(baseName(e.name));
    if (pl) visits[pl] = (visits[pl] || 0) + 1;
  }
  const all = allPlaces();
  const mine = (state.places || []).filter(p => all.includes(p));
  const rest = all.filter(p => !mine.includes(p)).sort((a, b) => (visits[b] || 0) - (visits[a] || 0) || a.localeCompare(b));
  return [...mine, ...rest].map(name => ({ name, visits: visits[name] || 0, mine: mine.includes(name) }));
}
// Where you probably are: the place of your last log, if it was in the last 3 hours.
function guessPlace() {
  const es = ((state.days[today] || {}).entries || []).filter(e => Date.now() - (e.t || 0) < 3 * 3600000);
  const last = es.sort((a, b) => b.t - a.t)[0];
  return last ? placeOf(baseName(last.name)) : null;
}
const gapScore = (tot, rem) => {
  const over = (val, left, scale) => Math.max(0, val - Math.max(left, 0)) / scale;
  return Math.max(0, rem.p - tot.p) / Math.max(rem.p, 1) + over(tot.cal, rem.cal, 200) + over(tot.c, rem.c, 20) + over(tot.f, rem.f, 10);
};
// Party trays and family packs aren't a meal for one.
const CATERING = /\btray\b|catering|bundle|family|gallon|dozen|\bbox of\b|\b(?:30|48|60|64|120|200)\s?(?:ct|pc|piece)/i;
// Best single items and two-item orders from one place that fit what's left.
function placeGapPicks(rem, place, n = 6) {
  const eaten = eatenCounts();
  const hour = new Date().getHours();
  const items = placeItems(place).filter(i => i.cal > 0 && i.cal <= rem.cal + 25 && !CATERING.test(i.name))
    // At school, stick to the meal being served now.
    .filter(i => place !== SCHOOL || !i.meal || (hour < 10 ? i.meal === 'Breakfast' : i.meal !== 'Breakfast'))
    .map(i => ({ ...i, p: i.p || 0, c: i.c || 0, f: i.f || 0, had: eaten[norm(i.name)] || 0 }));
  const one = i => gapScore(i, rem) - (i.had ? 0.12 : 0);
  // Pairs are built from the strongest items plus anything you've ordered there before.
  const pool = [...items].sort((a, b) => one(a) - one(b)).slice(0, 40);
  for (const i of items) if (i.had && !pool.includes(i)) pool.push(i);
  const combos = items.map(i => [i]);
  for (let a = 0; a < pool.length; a++) for (let b = a; b < pool.length; b++) {
    const x = pool[a], y = pool[b];
    if (x.cal + y.cal > rem.cal + 25 || (a === b && !x.p)) continue;
    // A drink or sauce with no protein doesn't help close the gap, so don't pair it.
    if (x.p < 3 || y.p < 3) continue;
    // School lunch is one entrée plus sides, not two entrées.
    if (place === SCHOOL && Math.min(x.cal, y.cal) > 200) continue;
    combos.push([x, y]);
  }
  const scored = combos.map(parts => {
    const tot = { cal: 0, p: 0, c: 0, f: 0 };
    for (const i of parts) for (const m in tot) tot[m] += i[m];
    const had = parts.some(i => i.had);
    return { parts, tot, had, score: gapScore(tot, rem) + (parts.length - 1) * 0.04 - (had ? 0.12 : 0) };
  }).filter(o => o.tot.p > 0).sort((a, b) => a.score - b.score);
  // Variety: the same main item shows up at most twice.
  const uses = {}, out = [], seen = new Set();
  for (const o of scored) {
    // Same items, or a different item with identical numbers (Jr. vs Kids' Hamburger): skip.
    const key = o.parts.map(i => `${i.cal}/${i.p}/${i.c}/${i.f}`).sort().join('|');
    const main = [...o.parts].sort((a, b) => b.p - a.p)[0].name;
    if (seen.has(key) || (uses[main] || 0) >= 2) continue;
    seen.add(key); uses[main] = (uses[main] || 0) + 1;
    const label = o.parts.length === 2 && o.parts[0] === o.parts[1] ? `2× ${o.parts[0].short}` : o.parts.map(i => i.short).join(' + ');
    const prefix = place === SCHOOL ? 'NPHS:' : place;
    out.push({ name: `${prefix} ${label}`, ...o.tot, src: o.parts[0].src, chain: place,
      serving: o.parts.length === 1 ? o.parts[0].serving : '', why: o.had ? "⭐ You've ordered this before" : '' });
    if (out.length >= n) break;
  }
  return out;
}

function localGapPicks(rem, n = 6) {
  const pool = [
    ...state.favorites.map(f => ({ ...f, src: 'fav' })),
    ...Object.values(state.barcodes).map(b => ({ ...b, src: 'scan' })),
    ...restaurants.map(i => ({ ...i, src: 'rest' })),
    ...cafeteria.map(i => ({ ...i, src: 'school' })),
  ].filter(i => i.name && i.cal > 0 && i.cal <= rem.cal + 25 && (i.p || 0) > 0);
  const over = (val, left, scale) => Math.max(0, val - Math.max(left, 0)) / scale;
  const seen = new Set(), eaten = eatenCounts();
  return pool.map(i => {
    const pShort = Math.max(0, rem.p - (i.p || 0)) / Math.max(rem.p, 1);
    const score = pShort + over(i.cal, rem.cal, 200) + over(i.c || 0, rem.c, 20) + over(i.f || 0, rem.f, 10)
      + { fav: -0.08, scan: -0.05, school: 0, rest: 0.02 }[i.src] - (eaten[norm(i.name)] ? 0.06 : 0);
    return { ...i, score };
  }).sort((a, b) => a.score - b.score)
    .filter(i => { const k = i.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, n);
}

function gapItemHTML(i, attr) {
  const tag = i.src === 'rest' && i.chain ? placeIcon(i.chain) : { fav: '⭐', scan: '📷', rest: '🍔', school: '🏫', ai: '✨' }[i.src] || '';
  const extra = i.portion ? `${esc(i.portion)} · ` : '';
  return `<button class="gap-item" type="button" ${attr}><b>${tag} ${esc(i.name)}</b>
    <small>${extra}${fmt(i.cal)} cal · P ${fmt1(i.p || 0)} · C ${fmt1(i.c || 0)} · F ${fmt1(i.f || 0)}</small>
    ${i.why ? `<small>${esc(i.why)}</small>` : ''}</button>`;
}

let gapLocal = [], gapIdeas = [];
function openGap() {
  const rem = remaining();
  $('#gap-left').innerHTML = [['cal', 'Calories', ''], ['p', 'Protein', 'g'], ['c', 'Carbs', 'g'], ['f', 'Fat', 'g']]
    .map(([k, label, u]) => `<div><b>${fmt(Math.max(0, rem[k]))}${u}</b><span>${label} left</span></div>`).join('');
  gapPlace = guessPlace();
  renderGapPicks();
  $('#gap-backdrop').hidden = false;
}
function renderGapPicks() {
  const rem = remaining();
  const places = gapPlaces();
  $('#gap-places').innerHTML = [{ name: null }, ...places].map(pl =>
    `<button class="chip${pl.name === gapPlace ? ' on' : ''}" type="button" data-gap-place="${pl.name ? esc(pl.name) : ''}">` +
    `${pl.name ? placeHTML(pl.name) : '🍽️ Anywhere'}</button>`).join('');
  $('#gap-local-title').textContent = gapPlace ? `Best orders at ${gapPlace === SCHOOL ? 'North Providence High' : gapPlace}` : 'From your foods';
  gapLocal = gapPlace ? placeGapPicks(rem, gapPlace) : localGapPicks(rem);
  $('#gap-local').innerHTML = gapLocal.length
    ? gapLocal.map((i, n) => gapItemHTML(i, `data-gap-local="${n}"`)).join('')
    : gapPlace ? `<div class="empty">Nothing at ${esc(gapPlace)} fits what's left. Try another place.</div>`
      : '<div class="empty">Nothing in your saved foods fits what\'s left. Try the ideas below.</div>';
  gapIdeas = [];
  $('#gap-ai').innerHTML = '';
  $('#gap-note').hidden = true;
  $('#gap-ai-btn').hidden = false;
  $('#gap-ai-btn').disabled = false;
  $('#gap-ai-btn').textContent = getAiKey() ? (gapPlace ? `✨ Order ideas at ${gapPlace === SCHOOL ? 'North Providence High' : gapPlace}` : '✨ Get meal ideas')
    : '✨ Meal ideas (add your API key in Settings)';
  const sel = $('#gap-places .chip.on');
  if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'center' });
}
function closeGap() { $('#gap-backdrop').hidden = true; }

const GAP_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'ideas'],
  properties: {
    summary: { type: 'string', description: 'One short sentence about the best approach for what is left' },
    ideas: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'portion', 'why', 'cal', 'p', 'c', 'f'],
        properties: {
          name: { type: 'string' }, portion: { type: 'string' }, why: { type: 'string', description: 'Why it fits, under 12 words' },
          cal: { type: 'number' }, p: { type: 'number' }, c: { type: 'number' }, f: { type: 'number' },
        },
      },
    },
  },
};

async function gapIdeasFromClaude() {
  if (!getAiKey()) { setView('settings'); closeGap(); toast('Add your Anthropic API key under Photo estimates'); return; }
  const rem = remaining();
  const btn = $('#gap-ai-btn');
  btn.disabled = true; btn.textContent = '✨ Thinking…';
  const usual = [...state.favorites].sort((a, b) => (b.uses || 0) - (a.uses || 0)).slice(0, 25)
    .map(f => `${f.name} (${fmt(f.cal)} cal, P${fmt1(f.p)} C${fmt1(f.c)} F${fmt1(f.f)})`).join('; ');
  const place = gapPlace, eaten = eatenCounts();
  // At a place: hand Claude that menu (best fits first, plus what they've ordered there) and nothing else.
  const menu = place ? placeItems(place).filter(i => i.cal > 0 && i.cal <= Math.max(rem.cal, 0) + 25)
    .map(i => ({ ...i, s: gapScore({ cal: i.cal, p: i.p || 0, c: i.c || 0, f: i.f || 0 }, rem) - (eaten[norm(i.name)] ? 0.12 : 0) }))
    .sort((a, b) => a.s - b.s).slice(0, 80)
    .map(i => `${i.short}${i.serving ? ` (${i.serving})` : ''}: ${fmt(i.cal)} cal, P${fmt1(i.p || 0)} C${fmt1(i.c || 0)} F${fmt1(i.f || 0)}${eaten[norm(i.name)] ? ' [ordered before]' : ''}`).join('\n') : '';
  try {
    const client = await aiClient();
    const res = await client.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: GAP_SCHEMA } },
      system: 'You suggest foods for a personal macro tracker. Given what is left of the day\'s targets, suggest 3 to 4 ' +
        'simple, realistic options (a single food or a quick meal) with specific portions that get as close as possible to ' +
        'the remaining protein without going over the remaining calories, and keep carbs and fat within what is left. ' +
        'Favor lean, high-protein foods and things the person already eats when they fit. Use standard nutrition values. ' +
        'If the remaining numbers are hard to hit exactly, say so in the summary and give the closest options.',
      messages: [{ role: 'user', content:
        `Left for today: ${fmt(Math.max(0, rem.cal))} calories, ${fmt(Math.max(0, rem.p))} g protein, ` +
        `${fmt(Math.max(0, rem.c))} g carbs, ${fmt(Math.max(0, rem.f))} g fat.` +
        (place ? `\nI'm at ${place === SCHOOL ? 'the North Providence High School cafeteria' : place} right now. Build 3 to 4 orders using ONLY items ` +
          `from this menu (one item or a combo; use the item names as written, joined with " + "), and use the menu's numbers. ` +
          `Prefer things marked [ordered before] when they fit.\nMenu:\n${menu || '(nothing on the menu fits)'}`
          : (usual ? ` Foods I eat often: ${usual}.` : '')) }],
    });
    if (res.stop_reason === 'refusal') throw new Error('refused');
    const block = res.content.find(b => b.type === 'text');
    if (!block) throw new Error('empty');
    const out = JSON.parse(block.text);
    gapIdeas = (out.ideas || []).map(i => ({ ...i, src: 'ai',
      name: place && !norm(i.name).startsWith(norm(place === SCHOOL ? 'NPHS' : place)) ? `${place === SCHOOL ? 'NPHS:' : place} ${i.name}` : i.name }));
    $('#gap-ai').innerHTML = gapIdeas.map((i, n) => gapItemHTML(i, `data-gap-ai="${n}"`)).join('');
    $('#gap-note').textContent = `✨ ${out.summary} Estimates; check them before logging.`;
    $('#gap-note').hidden = false;
    btn.hidden = true;
  } catch (e) {
    $('#gap-note').textContent = aiErrorMessage(e);
    $('#gap-note').hidden = false;
    btn.disabled = false; btn.textContent = '✨ Try again';
  }
}

function logGapPick(i) {
  closeGap();
  openSheet('add', null, { name: i.name, cal: i.cal, p: i.p || 0, c: i.c || 0, f: i.f || 0 });
  perServing = { cal: i.cal, p: i.p || 0, c: i.c || 0, f: i.f || 0 };
  setServings(1);
  $('#serving-row').hidden = false;
  $('#serving-info').textContent = i.portion ? `1 serving = ${i.portion}` : (i.serving ? `1 serving = ${i.serving}` : 'Per serving');
  scanNote(i.src === 'ai' ? '🎯 Suggested to close your gap (estimate). Adjust if your portion differs.' : '🎯 Suggested to close your gap.');
}

$('#gap-open').addEventListener('click', openGap);
$('#gap-close').addEventListener('click', closeGap);
$('#gap-backdrop').addEventListener('click', ev => { if (ev.target.id === 'gap-backdrop') closeGap(); });
$('#gap-ai-btn').addEventListener('click', gapIdeasFromClaude);
$('#gap-sheet').addEventListener('click', ev => {
  const pl = ev.target.closest('[data-gap-place]');
  if (pl) { gapPlace = pl.dataset.gapPlace || null; renderGapPicks(); return; }
  const l = ev.target.closest('[data-gap-local]'), a = ev.target.closest('[data-gap-ai]');
  if (l) logGapPick(gapLocal[+l.dataset.gapLocal]);
  if (a) logGapPick(gapIdeas[+a.dataset.gapAi]);
});

/* ================= Weekly report ================= */

// Where a logged food came from: restaurant entries start with the chain's name (or an alias).
function placeOf(name) {
  const n = norm(name);
  for (const ch of chainList) if (ch.keys.some(k => n === k || n.startsWith(k + ' '))) return ch.name;
  if (n.startsWith('school ') || n.startsWith('nphs ') || cafeteria.some(i => norm(i.name) === n)) return SCHOOL;
  return null;
}
const baseName = name => name.replace(/\s×[\d.]+$/, '');
const servingsIn = name => { const m = name.match(/\s×([\d.]+)$/); return m ? +m[1] || 1 : 1; };

function weekReport(ws) {
  const st = weekStats(ws);
  const entries = st.logged.flatMap(k => state.days[k].entries.map(e => ({ ...e, day: k, place: placeOf(baseName(e.name)) })));
  const foods = {};
  for (const e of entries) {
    const k = baseName(e.name).toLowerCase();
    const f = foods[k] || (foods[k] = { name: baseName(e.name), place: e.place, n: 0, cal: 0, p: 0, c: 0, f: 0 });
    f.n += servingsIn(e.name); for (const m of ['cal', 'p', 'c', 'f']) f[m] += +e[m] || 0;
  }
  const foodList = Object.values(foods);
  const places = {};
  for (const e of entries) if (e.place) {
    const pl = places[e.place] || (places[e.place] = { name: e.place, n: 0, cal: 0, p: 0, items: [] });
    pl.n++; pl.cal += +e.cal || 0; pl.p += +e.p || 0; pl.items.push(e);
  }
  return { ...st, entries, foods: foodList, places: Object.values(places).sort((a, b) => b.n - a.n) };
}

// Same-chain swap of the same kind (smoothie for smoothie, wrap for wrap): more protein per calorie,
// no more calories, at least as much protein. Compared per serving.
function betterAt(place, e) {
  const n = servingsIn(e.name), cal = (+e.cal || 0) / n, p = (+e.p || 0) / n;
  const ratio = p / Math.max(1, cal);
  const ate = restaurants.find(r => r.chain === place && norm(r.name) === norm(baseName(e.name)));
  let best = null;
  for (const r of restaurants) {
    if (r.chain !== place || !r.cal || !r.p) continue;
    if (norm(r.name) === norm(baseName(e.name))) continue;
    if (ate && ate.serving ? r.serving !== ate.serving : r.cal < cal * 0.5) continue;
    if (r.cal > cal || r.p < p || r.p / r.cal < ratio * 1.2) continue;
    if (!best || r.p / r.cal > best.p / best.cal) best = r;
  }
  return best;
}

function localTips(r) {
  const tips = [], g = r.g;
  const list = items => items.map(f => esc(f.name)).join(', ');
  if (r.done && r.logged.length < 7)
    tips.push({ icon: '📝', title: `Logged ${r.logged.length} of 7 days`, detail: 'Unlogged days are where progress hides. Aim for all seven, even rough guesses.' });
  const pShort = g.protein - r.avg.p;
  if (pShort > g.protein * 0.05) {
    const dense = r.foods.filter(f => f.p / f.n >= 10 && f.p / Math.max(1, f.cal) >= 0.08)
      .sort((a, b) => b.p / b.cal - a.p / a.cal).slice(0, 3);
    tips.push({ icon: '🥩', title: `Protein averaged ${fmt(r.avg.p)} g, ${fmt(pShort)} g a day short`,
      detail: dense.length ? `Your best protein-per-calorie foods this week were ${list(dense)}. Lean on them earlier in the day.`
        : 'Add a lean protein (chicken, egg whites, Greek yogurt, a shake) to each meal.' });
  }
  if (r.over.length >= 2) {
    const big = {};
    for (const e of r.entries) if (r.over.includes(e.day)) big[baseName(e.name)] = (big[baseName(e.name)] || 0) + (+e.cal || 0);
    const top = Object.entries(big).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${esc(n)} (${fmt(c)} cal)`);
    tips.push({ icon: '🔥', title: `Over calories on ${r.over.length} day${r.over.length === 1 ? '' : 's'}`,
      detail: `Biggest calories on those days: ${top.join(', ')}.` });
  }
  for (const [m, label, t] of [['c', 'Carbs', g.carbs], ['f', 'Fat', g.fat]]) {
    if (r.avg[m] <= t * 1.1) continue;
    const top = [...r.foods].sort((a, b) => b[m] - a[m]).slice(0, 3).map(f => `${esc(f.name)} (${fmt(f[m])} g)`);
    tips.push({ icon: m === 'c' ? '🍞' : '🧈', title: `${label} averaged ${fmt(r.avg[m])} g vs ${fmt(t)} g`, detail: `Biggest sources: ${top.join(', ')}.` });
  }
  for (const pl of r.places) {
    const seen = new Set();
    for (const e of [...pl.items].sort((a, b) => a.p / Math.max(1, a.cal) - b.p / Math.max(1, b.cal))) {
      const key = baseName(e.name).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const alt = betterAt(pl.name, e);
      if (!alt) continue;
      const n = servingsIn(e.name), cal = e.cal / n, p = e.p / n;
      tips.push({ icon: '🔁', title: `At ${esc(pl.name)}: swap ${esc(baseName(e.name).replace(pl.name + ' ', ''))}`,
        detail: `Try <b>${esc(alt.short)}</b>: ${fmt(alt.cal)} cal, P ${fmt(alt.p)} g, vs ${fmt(cal)} cal, P ${fmt(p)} g. ` +
          `${cal - alt.cal >= 1 ? `Saves ${fmt(cal - alt.cal)} cal` : 'Same calories'}${alt.p - p >= 1 ? `, +${fmt(alt.p - p)} g protein` : ''}.` });
      break;
    }
  }
  if (!tips.length) tips.push({ icon: '🎖️', title: 'Solid week', detail: 'Protein and calories were on target. Keep the same playbook.' });
  return tips;
}

// Real, well-known quotes only (Claude picks one from this list; it never writes its own).
const QUOTES = [
  { by: 'Michael Jordan', text: "I've missed more than 9,000 shots in my career. I've lost almost 300 games. 26 times I've been trusted to take the game-winning shot and missed. I've failed over and over and over again in my life. And that is why I succeed." },
  { by: 'Kobe Bryant', text: 'Everything negative – pressure, challenges – is all an opportunity for me to rise.' },
  { by: 'Kobe Bryant', text: 'The moment you give up is the moment you let someone else win.' },
  { by: 'Wayne Gretzky', text: "You miss 100% of the shots you don't take." },
  { by: 'Muhammad Ali', text: "I hated every minute of training, but I said, 'Don't quit. Suffer now and live the rest of your life as a champion.'" },
  { by: 'Vince Lombardi', text: 'The price of success is hard work, dedication to the job at hand, and the determination that whether we win or lose, we have applied the best of ourselves to the task at hand.' },
  { by: 'Tim Notke, made famous by Kevin Durant', text: 'Hard work beats talent when talent fails to work hard.' },
  { by: 'LeBron James', text: 'I like criticism. It makes you strong.' },
  { by: 'Serena Williams', text: 'I really think a champion is defined not by their wins but by how they can recover when they fall.' },
  { by: 'Babe Ruth', text: "It's hard to beat a person who never gives up." },
  { by: 'Jerry Rice', text: "Today I will do what others won't, so tomorrow I can accomplish what others can't." },
  { by: 'Stephen Curry', text: 'Success is not an accident, success is actually a choice.' },
  { by: 'Dwayne "The Rock" Johnson', text: "Success isn't always about greatness. It's about consistency. Consistent hard work leads to success. Greatness will come." },
  { by: 'Bill Belichick', text: 'Do your job.' },
  { by: 'Arnold Schwarzenegger', text: 'The last three or four reps is what makes the muscle grow.' },
  { by: 'John Wooden', text: "Don't let what you cannot do interfere with what you can do." },
  { by: 'Pelé', text: 'Success is no accident. It is hard work, perseverance, learning, studying, sacrifice and most of all, love of what you are doing or learning to do.' },
  { by: 'Derek Jeter', text: "There may be people that have more talent than you, but there's no excuse for anyone to work harder than you do." },
  { by: 'Michael Phelps', text: "You can't put a limit on anything. The more you dream, the farther you get." },
  { by: 'Usain Bolt', text: 'I trained four years to run nine seconds.' },
  { by: 'Lou Holtz', text: "It's not the load that breaks you down, it's the way you carry it." },
  { by: 'Dan Gable', text: "Gold medals aren't really made of gold. They're made of sweat, determination, and a hard-to-find alloy called guts." },
  { by: 'Kareem Abdul-Jabbar', text: 'Your mind is what makes everything else work.' },
  { by: 'Nelson Mandela', text: 'It always seems impossible until it is done.' },
  { by: 'Michael Jordan', text: 'Some people want it to happen, some wish it would happen, others make it happen.' },
  { by: 'Michael Jordan', text: 'Talent wins games, but teamwork and intelligence win championships.' },
  { by: 'Kobe Bryant', text: 'Dedication makes dreams come true.' },
  { by: 'Magic Johnson', text: 'All kids need is a little help, a little hope and somebody who believes in them.' },
  { by: 'Larry Bird', text: 'A winner is someone who recognizes his God-given talents, works his tail off to develop them into skills, and uses these skills to accomplish his goals.' },
  { by: 'Bill Russell', text: 'Concentration and mental toughness are the margins of victory.' },
  { by: "Tim Duncan's motto, from his mother", text: 'Good, better, best. Never let it rest. Until your good is better and your better is best.' },
  { by: 'Giannis Antetokounmpo', text: "There's no failure in sports. There's good days, bad days. Some days you are able to be successful, some days you're not." },
  { by: 'Kevin Garnett', text: 'Anything is possible!' },
  { by: 'Jim Valvano', text: "Don't give up. Don't ever give up." },
  { by: 'Vince Lombardi', text: "It's not whether you get knocked down, it's whether you get up." },
  { by: 'Vince Lombardi', text: 'Practice does not make perfect. Only perfect practice makes perfect.' },
  { by: 'Walter Payton', text: 'Never die easy.' },
  { by: 'Bo Jackson', text: "Set your goals high, and don't stop till you get there." },
  { by: 'Tom Landry', text: 'Setting a goal is not the main thing. It is deciding how you will go about achieving it and staying with that plan.' },
  { by: 'Bill Walsh', text: "Champions behave like champions before they're champions." },
  { by: 'Bill Walsh', text: 'The score takes care of itself.' },
  { by: 'Roger Staubach', text: 'There are no traffic jams along the extra mile.' },
  { by: 'Joe Namath', text: 'When you have confidence, you can have a lot of fun. And when you have fun, you can do amazing things.' },
  { by: 'Deion Sanders', text: 'If you look good, you feel good. If you feel good, you play good. If you play good, they pay good.' },
  { by: 'Mike Tyson', text: 'Everybody has a plan until they get punched in the mouth.' },
  { by: 'Hank Aaron', text: 'My motto was always to keep swinging. Whether I was in a slump or feeling badly or having trouble off the field, the only thing to do was keep swinging.' },
  { by: 'Jesse Owens', text: 'We all have dreams. But in order to make dreams come into reality, it takes an awful lot of determination, dedication, self-discipline, and effort.' },
  { by: 'Wilma Rudolph', text: 'Never underestimate the power of dreams and the influence of the human spirit.' },
  { by: 'Jackie Joyner-Kersee', text: 'The glory of sport comes from dedication, determination, and desire.' },
  { by: 'Simone Biles', text: "I'd rather regret the risks that didn't work out than the chances I didn't take at all." },
  { by: 'Cristiano Ronaldo', text: 'Talent without working hard is nothing.' },
  { by: 'Lionel Messi', text: 'You have to fight to reach your dream. You have to sacrifice and work hard for it.' },
  { by: 'Eliud Kipchoge', text: 'No human is limited.' },
];
// Quotes not used in any other week yet (starts over once all have been seen).
function freshQuotes(ws) {
  const used = new Set(Object.entries(state.reports).filter(([k]) => k !== ws).map(([, r]) => r.quote).filter(n => n != null));
  const fresh = QUOTES.map((_, i) => i).filter(i => !used.has(i));
  return fresh.length ? fresh : QUOTES.map((_, i) => i);
}
function weekQuote(ws) {
  const rec = state.reports[ws] || (state.reports[ws] = {});
  if (rec.quote == null || !QUOTES[rec.quote]) {
    const fresh = freshQuotes(ws);
    rec.quote = fresh[Math.floor(Math.random() * fresh.length)];
    save();
  }
  return QUOTES[rec.quote];
}

// The whole journey up to the end of a week: first log, starting weight, totals.
function journey(ws) {
  const end = shiftKey(ws, 6);
  const keys = Object.keys(state.days).filter(k => k <= end && state.days[k].entries.length).sort();
  const ws_ = sortedWeights().filter(w => w.k <= shiftKey(ws, 7));
  const first = ws_[0], last = ws_[ws_.length - 1];
  let best = 0, run = 0, prev = null;
  for (const k of keys.filter(isHit)) { run = prev && shiftKey(prev, 1) === k ? run + 1 : 1; best = Math.max(best, run); prev = k; }
  return {
    since: keys[0] || null,
    weeks: keys.length ? Math.floor((parseKey(end) - parseKey(weekStart(keys[0]))) / (7 * 86400000)) + 1 : 0,
    daysLogged: keys.length, daysHit: keys.filter(isHit).length, bestStreak: best,
    startW: first ? first.w : null, nowW: last ? last.w : null,
    lost: first && last && first.k !== last.k ? first.w - last.w : null,
  };
}

// The week that just ended opens by itself the first time the app is opened after it
// (Sunday, right after the weigh-in when the Sunday lock is on).
/* ---- Where do you eat? (asked once, editable in Settings) ---- */
let pickOrder = [];
function openPlacesPicker() {
  pickOrder = [...(state.places || [])];
  renderPlacesPicker();
  $('#places-pick').hidden = false;
  $('#places-pick').scrollTop = 0;
}
function renderPlacesPicker() {
  $('#pp-list').innerHTML = allPlaces().map(pl => {
    const n = pickOrder.indexOf(pl) + 1;
    return `<button type="button" class="pp-item${n ? ' on' : ''}" data-pp="${esc(pl)}"><span>${placeHTML(pl)}</span>${n ? `<b>${n}</b>` : ''}</button>`;
  }).join('');
  $('#pp-save').textContent = pickOrder.length ? `Save ${pickOrder.length} place${pickOrder.length === 1 ? '' : 's'}` : 'Save';
}
$('#pp-list').addEventListener('click', ev => {
  const b = ev.target.closest('[data-pp]');
  if (!b) return;
  const pl = b.dataset.pp, i = pickOrder.indexOf(pl);
  if (i >= 0) pickOrder.splice(i, 1); else pickOrder.push(pl);
  renderPlacesPicker();
});
function closePlacesPicker(places) {
  state.places = places;
  save();
  $('#places-pick').hidden = true;
  render();
}
$('#pp-save').addEventListener('click', () => { closePlacesPicker(pickOrder); toast(pickOrder.length ? 'Your places are saved 🍔' : 'Saved'); });
$('#pp-skip').addEventListener('click', () => closePlacesPicker(state.places || []));
function renderMyPlaces() {
  const mine = state.places || [];
  $('#my-places').innerHTML = mine.length ? mine.map(placeHTML).join(' · ') : 'None picked yet.';
}
$('#edit-places').addEventListener('click', openPlacesPicker);

function maybeAutoReport() {
  if (!menusLoaded || state.needsSetup || weighinDue() || !$('#report-backdrop').hidden) return;
  if (!$('#places-pick').hidden) return;
  // New profile: ask where they eat first (needs the menus loaded to list the places).
  if (state.places === null && $('#setup').hidden) { openPlacesPicker(); return; }
  if (!$('#backdrop').hidden || !$('#setup') || !$('#setup').hidden) return;
  const ws = shiftKey(weekStart(today), -7);
  if ((state.reports[ws] || {}).seen || !weekStats(ws).logged.length) return;
  openReport(ws, { auto: true });
}

let reportWeek = null;
function openReport(ws, opts = {}) {
  const r = weekReport(ws), g = r.g;
  reportWeek = ws;
  $('#report-title').textContent = r.done ? 'Weekly report' : 'Week so far';
  $('#report-range').textContent = `${weekRange(ws)} · ${r.logged.length} day${r.logged.length === 1 ? '' : 's'} logged`;
  const toGo = r.wEnd ? r.wEnd.w - state.settings.goalWeight : null;
  $('#report-stats').innerHTML =
    statHTML(r.wEnd ? fmt1(r.wEnd.w) : '—', 'Weight') +
    statHTML(r.change == null ? '—' : (r.change > 0 ? '+' : '') + fmt1(r.change), 'Change') +
    statHTML(toGo == null ? '—' : toGo > 0 ? fmt1(toGo) : '🎯', 'To go') +
    statHTML(`${r.hits}/${r.logged.length}`, 'Days hit') +
    statHTML(r.over.length, 'Over cal') +
    statHTML('🔥 ' + currentStreak(), 'Streak');
  $('#report-strip').innerHTML = r.days.map(k => {
    const has = r.logged.includes(k), cls = !has ? (k > today ? 'future' : 'none') : isHit(k) ? 'hit' : 'miss';
    const letter = parseKey(k).toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2);
    return `<div class="${cls}"><span>${letter}</span><b>${cls === 'hit' ? '✓' : cls === 'miss' ? '✗' : '–'}</b></div>`;
  }).join('');
  $('#report-bars').innerHTML = MACROS.map(m => {
    const v = r.avg[m.k], t = g[m.t], over = v > t;
    const w = t > 0 ? Math.min(100, (v / t) * 100) : 0;
    const cls = over ? (m.k === 'p' ? 'good' : 'over') : '';
    return `<span>${m.short}</span><div class="bar"><i style="width:${w}%;background:${over && m.k !== 'p' ? 'var(--over)' : m.color}"></i></div>` +
      `<span class="v ${cls}">${fmt(v)} / ${fmt(t)}${m.unit}</span>`;
  }).join('');
  const top = [...r.foods].sort((a, b) => b.n - a.n || b.cal - a.cal).slice(0, 5);
  $('#report-foods').innerHTML = top.map(f =>
    `<div><span>${esc(f.name)}${f.n > 1 ? ` <b>×${f.n}</b>` : ''}</span><span>${fmt(f.cal)} cal · P${fmt(f.p)}</span></div>`).join('');
  $('#report-places-wrap').hidden = !r.places.length;
  $('#report-places').innerHTML = r.places.map(p =>
    `<div><span>${placeHTML(p.name)} <b>×${p.n}</b></span><span>${fmt(p.cal)} cal · P${fmt(p.p)}</span></div>`).join('');
  $('#report-tips').innerHTML = localTips(r).map(t =>
    `<div class="advice"><b>${t.icon} ${t.title}</b><p>${t.detail}</p></div>`).join('');
  const j = journey(ws);
  $('#report-journey').innerHTML =
    statHTML(j.lost == null ? '—' : (j.lost >= 0 ? '−' : '+') + fmt1(Math.abs(j.lost)), j.lost == null || j.lost >= 0 ? 'Lbs lost' : 'Lbs gained') +
    statHTML(j.weeks, j.weeks === 1 ? 'Week' : 'Weeks') +
    statHTML(`${j.daysHit}/${j.daysLogged}`, 'Days hit') +
    statHTML(j.startW == null ? '—' : fmt1(j.startW), 'Start') +
    statHTML(j.nowW == null ? '—' : fmt1(j.nowW), 'Now') +
    statHTML('🔥 ' + j.bestStreak, 'Best streak');
  $('#report-journey-note').textContent = j.since ? `Since ${parseKey(j.since).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}` : '';
  if (r.done) { (state.reports[ws] = state.reports[ws] || {}).seen = true; save(); }
  showQuote(ws);
  const saved = state.reports[ws];
  if (saved && saved.ai) showCoach(saved.ai);
  else {
    $('#report-ai').innerHTML = '';
    $('#report-note').hidden = true;
    $('#report-ai-btn').hidden = false;
    $('#report-ai-btn').disabled = false;
    $('#report-ai-btn').textContent = getAiKey() ? '✨ Get coaching from Claude' : '✨ Coaching (add your API key in Settings)';
  }
  $('#report-backdrop').hidden = false;
  $('#report-sheet').scrollTop = 0;
  if (opts.auto && !(saved && saved.ai) && getAiKey()) coachFromClaude();
}
function showQuote(ws, talk) {
  const q = weekQuote(ws);
  $('#report-quote').innerHTML = `<blockquote>“${esc(q.text)}”</blockquote><cite>— ${esc(q.by)}</cite>` +
    (talk ? `<p class="pep">${esc(talk)}</p>` : '');
}
function closeReport() { $('#report-backdrop').hidden = true; reportWeek = null; }

function showCoach(out) {
  if (out.quote_id != null && QUOTES[out.quote_id] && reportWeek) {
    state.reports[reportWeek].quote = out.quote_id; save();
  }
  if (reportWeek) showQuote(reportWeek, out.pep_talk);
  const li = a => (a || []).map(x => `<li>${esc(x)}</li>`).join('');
  $('#report-ai').innerHTML =
    `<p class="coach-head">${esc(out.headline)}</p>` +
    (out.wins && out.wins.length ? `<h4>What worked</h4><ul>${li(out.wins)}</ul>` : '') +
    (out.fixes && out.fixes.length ? `<h4>Fix this week</h4>${out.fixes.map(f => `<div class="advice"><b>${esc(f.title)}</b><p>${esc(f.detail)}</p></div>`).join('')}` : '') +
    (out.swaps && out.swaps.length ? `<h4>Smarter orders</h4>${out.swaps.map(w =>
      `<div class="advice"><b>${w.place ? esc(w.place) + ': ' : ''}${esc(w.instead_of)} → ${esc(w.try_this)}</b><p>${esc(w.why)}</p></div>`).join('')}` : '');
  $('#report-note').textContent = '✨ From Claude, based on your log. Numbers are estimates.';
  $('#report-note').hidden = false;
  $('#report-ai-btn').hidden = true;
}

const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['headline', 'wins', 'fixes', 'swaps', 'pep_talk', 'quote_id'],
  properties: {
    pep_talk: { type: 'string', description: '3 to 5 sentences of locker-room motivation for next week, tied to this week and to the chosen quote' },
    quote_id: { type: 'integer', description: 'id of the one quote from the list that best fits this week' },
    headline: { type: 'string', description: 'One or two sentences summing up the week, direct and encouraging' },
    wins: { type: 'array', items: { type: 'string' }, description: '1 to 3 short things that went well' },
    fixes: {
      type: 'array', description: '2 to 4 specific changes for next week, tied to the foods and places in the log. Cover any macro that was well under or well over target.',
      items: { type: 'object', additionalProperties: false, required: ['title', 'detail'],
        properties: { title: { type: 'string' }, detail: { type: 'string' } } },
    },
    swaps: {
      type: 'array', description: '0 to 4 swaps for foods actually eaten this week, at the same place when there was one',
      items: { type: 'object', additionalProperties: false, required: ['place', 'instead_of', 'try_this', 'why'],
        properties: { place: { type: 'string' }, instead_of: { type: 'string' }, try_this: { type: 'string' }, why: { type: 'string' } } },
    },
  },
};

const coaching = new Set(); // weeks with a request in flight or done this session
async function coachFromClaude() {
  if (!getAiKey()) { closeReport(); setView('settings'); toast('Add your Anthropic API key under Photo estimates'); return; }
  const ws = reportWeek, r = weekReport(ws), g = r.g;
  if (coaching.has(ws)) return;
  coaching.add(ws);
  const btn = $('#report-ai-btn');
  btn.disabled = true; btn.textContent = '✨ Reviewing your week…';
  const days = r.days.map(k => {
    const d = state.days[k];
    const label = parseKey(k).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (!d || !d.entries.length) return `${label}: not logged`;
    const t = totals(k);
    return `${label}: ${fmt(t.cal)} cal, P${fmt(t.p)} C${fmt(t.c)} F${fmt(t.f)}${isHit(k) ? ' (hit)' : ''}`;
  }).join('\n');
  const foods = [...r.foods].sort((a, b) => b.cal - a.cal).slice(0, 40).map(f =>
    `${f.name}${f.place ? ` [${f.place}]` : ''} ×${f.n}: ${fmt(f.cal / f.n)} cal, P${fmt1(f.p / f.n)} C${fmt1(f.c / f.n)} F${fmt1(f.f / f.n)} each`).join('\n');
  const j = journey(ws), age = (state.profile || {}).age;
  const quoteIds = freshQuotes(ws);
  const quotes = quoteIds.map(i => `${i}: "${QUOTES[i].text}" (${QUOTES[i].by})`).join('\n');
  const progress = j.since ? `Tracking since ${j.since}: ${j.weeks} weeks, ${j.daysHit} of ${j.daysLogged} logged days hit, best streak ${j.bestStreak} days` +
    (j.startW != null ? `, weight ${fmt1(j.startW)} → ${fmt1(j.nowW)} lbs` : '') + '.' : '';
  const weight = r.wEnd ? `${fmt1(r.wEnd.w)} lbs${r.change != null ? ` (${r.change > 0 ? '+' : ''}${fmt1(r.change)} this week)` : ''}, goal ${fmt1(state.settings.goalWeight)} lbs` : 'no weigh-in';
  try {
    const client = await aiClient();
    const res = await client.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: REPORT_SCHEMA } },
      system: 'You are a practical nutrition coach and hype man reviewing one week of a personal macro log. The reader may be a ' +
        'high school athlete, so talk like a good coach talks to a teenager: direct, upbeat, no lecturing. Base every point on the ' +
        'foods and places actually in the log: name them. Call out any macro that was well under or well over its target ' +
        '(including protein far above target) and say what to change. Prefer swaps at the same restaurant, or simple changes to ' +
        'foods they already eat, over generic advice. Keep each item short and concrete (portions, calories, grams). ' +
        'Keep advice safe for a growing teenager: never suggest eating below the calorie target, skipping meals, crash diets or ' +
        'supplements beyond protein; if they are often far under calories, tell them to eat enough. No medical advice. ' +
        'For quote_id, choose only from the numbered quotes given (never write or alter a quote), and write the pep talk in your ' +
        'own words, connecting that quote to their week.',
      messages: [{ role: 'user', content:
        `Daily targets: ${fmt(g.cal)} cal, ${fmt(g.protein)} g protein, ${fmt(g.carbs)} g carbs, ${fmt(g.fat)} g fat.\n` +
        `Weight: ${weight}.${age ? ` Age: ${age}.` : ''}\n${progress}\nWeek ${weekRange(ws)}:\n${days}\n\nFoods eaten this week:\n${foods}` +
        `\n\nQuotes to choose from:\n${quotes}` }],
    });
    if (res.stop_reason === 'refusal') throw new Error('refused');
    const block = res.content.find(b => b.type === 'text');
    if (!block) throw new Error('empty');
    const out = JSON.parse(block.text);
    if (!quoteIds.includes(out.quote_id)) delete out.quote_id;
    state.reports[ws] = { ...(state.reports[ws] || {}), ai: out, at: Date.now() };
    save();
    if (reportWeek === ws) showCoach(out);
  } catch (e) {
    coaching.delete(ws);
    if (reportWeek !== ws) return;
    $('#report-note').textContent = aiErrorMessage(e);
    $('#report-note').hidden = false;
    btn.disabled = false; btn.textContent = '✨ Try again';
  }
}
$('#report-close').addEventListener('click', closeReport);
$('#report-backdrop').addEventListener('click', ev => { if (ev.target.id === 'report-backdrop') closeReport(); });
$('#report-ai-btn').addEventListener('click', coachFromClaude);

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
  const rep = ev.target.closest('[data-report]');
  if (rep) { openReport(rep.dataset.report); return; }
  const add = ev.target.closest('[data-meal-add]');
  if (add) { openSheet('add', null, null, +add.dataset.mealAdd); return; }
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
  Object.assign(s, { cal: v('#s-cal'), protein: v('#s-protein'), carbs: v('#s-carbs'), fat: v('#s-fat'), goalWeight: v('#s-goal'), sundayLock: $('#s-sunday').checked });
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
  openSetup(true);
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

/* ================= Invite-only sign-in ================= */
// invites.json lists one entry per invited person: id = fingerprint of their email, h = fingerprint
// of email + invite code. Neither can be turned back into the email or code. scripts/invite.mjs
// adds and removes people; these settings must match it.
const INVITE_ITER = 200000;
const normEmail = e => String(e || '').trim().toLowerCase();
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function pbkdf2Hex(secret, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: INVITE_ITER }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const inviteId = email => pbkdf2Hex(normEmail(email), 'opmacro-id').then(h => h.slice(0, 16));
const inviteHash = (email, code) => pbkdf2Hex(normCode(code), 'opmacro:' + normEmail(email));
async function fetchInvites() {
  const res = await fetch('invites.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('invites ' + res.status);
  return (await res.json()).invites || [];
}

function showSignin(msg) {
  $('#signin').hidden = false;
  $('#signin-note').textContent = msg || '';
  $('#signin-note').hidden = !msg;
}

// Moves this phone's pre-sign-in data into the account, if it's theirs.
function claimLegacyData(a) {
  const key = `${LEGACY_KEY}:${a.id}`;
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem(LEGACY_KEY)); } catch (e) { /* none */ }
  if (!legacy || localStorage.getItem(key)) return;
  const n = Object.values(legacy.days || {}).filter(d => d.entries && d.entries.length).length;
  if (!confirm(`This phone already has Operation Macro data (${n} day${n === 1 ? '' : 's'} logged). Is it yours?\n\nOK: move it into ${a.email}.\nCancel: start fresh.`)) return;
  localStorage.setItem(key, localStorage.getItem(LEGACY_KEY));
  localStorage.removeItem(LEGACY_KEY);
  const ai = localStorage.getItem(LEGACY_AI_KEY);
  if (ai) { localStorage.setItem(`${LEGACY_AI_KEY}:${a.id}`, ai); localStorage.removeItem(LEGACY_AI_KEY); }
}

$('#signin-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const email = normEmail($('#si-email').value), code = normCode($('#si-code').value);
  const note = msg => { $('#signin-note').textContent = msg; $('#signin-note').hidden = false; };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return note('Enter your email address.');
  if (code.length < 6) return note('Enter the invite code you were texted.');
  const btn = $('#si-go');
  btn.disabled = true; btn.textContent = 'Checking…';
  $('#signin-note').hidden = true;
  try {
    const [invites, h, id] = await Promise.all([fetchInvites(), inviteHash(email, code), inviteId(email)]);
    if (!invites.some(i => i.h === h)) {
      note("That email and code don't match an invite. Check both, or ask for a new code.");
    } else {
      const a = { id, email, h };
      localStorage.setItem(ACCOUNT_SLOT, JSON.stringify(a));
      claimLegacyData(a);
      location.reload();
      return;
    }
  } catch (e) {
    note("Couldn't check your invite. You need internet the first time you sign in.");
  }
  btn.disabled = false; btn.textContent = 'Sign in';
});

function signOut(msg) {
  try { localStorage.removeItem(ACCOUNT_SLOT); } catch (e) { /* ignore */ }
  if (msg) sessionStorage.setItem('opmacro_signin_msg', msg);
  location.reload();
}
// Removed from invites.json (or given a new code): locked out on the next launch with internet.
async function checkAccount() {
  let invites;
  try { invites = await fetchInvites(); } catch (e) { return; } // offline: keep working
  if (!invites.some(i => i.h === account.h)) signOut('Your invite has ended or changed. Sign in with your new code, or ask for a new invite.');
}
function renderAccount() {
  $('#account-card').hidden = !account;
  if (account) $('#account-email').textContent = account.email;
}
$('#sign-out').addEventListener('click', () => {
  if (confirm("Sign out? Your logs stay saved on this phone, and you'll need your invite code to sign back in.")) signOut();
});

/* ================= Boot ================= */

// Welcome note on every launch: "Welcome to a better you" the very first time on this phone,
// the motto after that. Tap anywhere (or wait a few seconds) to go in.
const WELCOMED_SLOT = 'opmacro_welcomed';
let welcomedBefore = false;
try { welcomedBefore = !!localStorage.getItem(WELCOMED_SLOT); localStorage.setItem(WELCOMED_SLOT, '1'); } catch (e) { /* storage blocked */ }
if (welcomedBefore) {
  $('#welcome-title').textContent = 'The life you want starts with the life you live.';
  $('#welcome').classList.add('motto');
}
function closeWelcome() {
  const w = $('#welcome');
  if (w.hidden || w.classList.contains('out')) return;
  w.classList.add('out');
  setTimeout(() => { w.hidden = true; }, 350);
}
$('#welcome').addEventListener('click', closeWelcome);
setTimeout(closeWelcome, 4500);

if (authOn && !account) {
  const msg = sessionStorage.getItem('opmacro_signin_msg');
  sessionStorage.removeItem('opmacro_signin_msg');
  showSignin(msg);
} else {
  save();
  loadCafeteria();
  setView('today');
  if (state.needsSetup) openSetup(true);
  if (account) checkAccount();
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
