(() => {
'use strict';

/* ───────────────────────── backend bridge ───────────────────────── */
const TAURI = window.__TAURI__;
const invoke = (cmd, args) => TAURI.core.invoke(cmd, args);
const EXT = ['mp3', 'm4a', 'm4b', 'mp4', 'flac', 'ogg', 'oga', 'opus', 'wav', 'aif', 'aiff', 'wv', 'ape'];

/* ───────────────────────── columns ───────────────────────── */
// Default visible set = the list requested; the rest can be added from the header menu.
const COLS = [
  { id: 'filename',   label: 'Filename',     w: 300, ro: true,  def: true },
  { id: 'track',      label: 'Track',        w: 70,  num: true, def: true },
  { id: 'disc',       label: 'Disc',         w: 70,  num: true, def: true },
  { id: 'year',       label: 'Year',         w: 90,  def: true },
  { id: 'artist',     label: 'Artist',       w: 170, def: true },
  { id: 'album_artist', label: 'Album Artist', w: 170, def: true },
  { id: 'title',      label: 'Title',        w: 240, def: true },
  { id: 'genre',      label: 'Genre',        w: 110, def: true },
  { id: 'sort_album', label: 'Sort Album',   w: 170, def: true },
  { id: 'kind',       label: 'Kind',         w: 60,  ro: true,  def: true },
  { id: 'album',      label: 'Album',        w: 200 },
  { id: 'comment',    label: 'Comment',      w: 200 },
  { id: 'composer',   label: 'Composer',     w: 160 },
  { id: 'bitrate',    label: 'Bit Rate',     w: 90,  ro: true, num: true },
  { id: 'duration',   label: 'Time',         w: 70,  ro: true, num: true },
  { id: 'size',       label: 'Size',         w: 80,  ro: true, num: true },
  { id: 'path',       label: 'Location',     w: 320, ro: true },
];
const COL = Object.fromEntries(COLS.map(c => [c.id, c]));
const EDITABLE = COLS.filter(c => !c.ro).map(c => c.id);
const STORE_KEY = 'musictag.cols.v1';

function loadCols() {
  const dflt = { order: COLS.map(c => c.id), hidden: COLS.filter(c => !c.def).map(c => c.id), widths: {} };
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (s && Array.isArray(s.order)) {
      const order = s.order.filter(id => COL[id]);
      COLS.forEach(c => { if (!order.includes(c.id)) order.push(c.id); });
      return { order, hidden: (s.hidden || []).filter(id => COL[id]), widths: s.widths || {} };
    }
  } catch (_) { /* storage unavailable */ }
  return dflt;
}
function saveCols() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S.cols)); } catch (_) { /* ignore */ }
}

/* ───────────────────────── state ───────────────────────── */
const S = {
  tracks: new Map(),          // path -> track
  groups: new Map(),          // album key -> [track]
  cards: new Map(),           // album key -> element
  cols: loadCols(),
  sort: { id: '_default', dir: 1 },
  sel: null,
  armed: false,
};
const coverCache = new Map(); // path -> Promise<dataUrl|null>

const $ = (s, r = document) => r.querySelector(s);
const albumsEl = $('#albums');
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === 'data') Object.assign(e.dataset, v);
    else e.setAttribute(k, v);
  }
  kids.flat().forEach(k => k != null && e.append(k));
  return e;
}

/* ───────────────────────── track model ───────────────────────── */
const comb = (n, t) => (t ? `${n}/${t}` : n || '');
function mkTrack(i) {
  return {
    path: i.path, ed: {}, coverFrom: null,
    base: {
      filename: i.filename, kind: i.kind, path: i.path,
      title: i.title, artist: i.artist, album: i.album, album_artist: i.album_artist,
      genre: i.genre, sort_album: i.sort_album, comment: i.comment, composer: i.composer,
      year: i.year, track: comb(i.track, i.track_total), disc: comb(i.disc, i.disc_total),
      bitrate: i.bitrate, duration: i.duration, size: i.size, cover: i.cover,
    },
  };
}
const val = (t, f) => (f in t.ed ? t.ed[f] : t.base[f]) ?? '';
function setVal(t, f, v) {
  v = String(v ?? '').trim();
  if (v === t.base[f]) delete t.ed[f]; else t.ed[f] = v;
}
const isDirty = t => Object.keys(t.ed).length > 0 || !!t.coverFrom;
const keyOf = t => val(t, 'album').trim();
function cov(t) {
  if (t.coverFrom) { const s = S.tracks.get(t.coverFrom); return s ? s.base.cover : null; }
  return t.base.cover;
}
const pixels = c => (c ? c.width * c.height : 0);

function pair(s) {
  const m = /^\s*(\d*)\s*\/?\s*(\d*)\s*$/.exec(s || '');
  return { n: m && m[1] ? parseInt(m[1], 10) : null, t: m && m[2] ? parseInt(m[2], 10) : null };
}

function cellText(t, id) {
  switch (id) {
    case 'bitrate': return t.base.bitrate ? `${t.base.bitrate} kbps` : '';
    case 'duration': { const s = Math.round(t.base.duration || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
    case 'size': return `${(t.base.size / 1048576).toFixed(1)} MB`;
    default: return val(t, id);
  }
}

/* ───────────────────────── grouping & sorting ───────────────────────── */
function regroup() {
  S.groups = new Map();
  for (const t of S.tracks.values()) {
    const k = keyOf(t);
    if (!S.groups.has(k)) S.groups.set(k, []);
    S.groups.get(k).push(t);
  }
}
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
function sortedKeys() {
  return [...S.groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : collator.compare(a, b)));
}
function sortRows(list) {
  const { id, dir } = S.sort;
  const num = t => (pair(val(t, 'track')).n ?? 1e9);
  const disc = t => (pair(val(t, 'disc')).n ?? 0);
  const cmp = (a, b) => {
    if (id === '_default') return disc(a) - disc(b) || num(a) - num(b) || collator.compare(a.base.filename, b.base.filename);
    let x, y;
    if (id === 'track') { x = num(a); y = num(b); }
    else if (id === 'disc') { x = disc(a); y = disc(b); }
    else if (id === 'year') { x = parseInt(val(a, 'year'), 10) || 0; y = parseInt(val(b, 'year'), 10) || 0; }
    else if (['bitrate', 'duration', 'size'].includes(id)) { x = a.base[id]; y = b.base[id]; }
    else return collator.compare(cellText(a, id), cellText(b, id)) * dir;
    return (x - y) * dir;
  };
  return [...list].sort(cmp);
}

/* ───────────────────────── covers ───────────────────────── */
function coverUrl(path) {
  if (!coverCache.has(path)) coverCache.set(path, invoke('get_cover', { path }).catch(() => null));
  return coverCache.get(path);
}
function bestCoverTrack(list) {
  let best = null;
  for (const t of list) {
    const c = cov(t); if (!pixels(c)) continue;
    const bc = best && cov(best);
    if (!best || pixels(c) > pixels(bc) || (pixels(c) === pixels(bc) && c.bytes > bc.bytes)) best = t;
  }
  return best;
}
function updateCover(card, list) {
  const best = bestCoverTrack(list);
  const srcPath = best ? (best.coverFrom || best.path) : null;
  const box = $('.cover', card), meta = $('.cover-meta', card);
  if (card._cover !== srcPath) {
    card._cover = srcPath;
    box.replaceChildren(srcPath ? '' : '♪');
    if (srcPath) coverUrl(srcPath).then(u => { if (card._cover === srcPath) box.replaceChildren(u ? h('img', { src: u, draggable: 'false' }) : '♪'); });
  }
  meta.replaceChildren();
  if (!best) { meta.textContent = 'No cover'; return; }
  const c = cov(best);
  const sizes = new Set(list.map(t => { const x = cov(t); return x && pixels(x) ? `${x.width}×${x.height}` : 'none'; }));
  meta.append(`${c.width} × ${c.height}`);
  if (sizes.size > 1) meta.append(' · ', h('span', { class: 'warn', text: 'mixed' }));
}

/* ───────────────────────── rendering ───────────────────────── */
const FIELDS = [
  ['album', 'Album'], ['album_artist', 'Album Artist'], ['artist', 'Artist'],
  ['year', 'Year'], ['genre', 'Genre'], ['sort_album', 'Sort Album'],
];
const visible = () => S.cols.order.filter(id => !S.cols.hidden.includes(id));
const colW = id => S.cols.widths[id] || COL[id].w;
function applyTemplate() {
  albumsEl.style.setProperty('--cols', visible().map(id => `${colW(id)}px`).join(' '));
}

function buildCard(key) {
  const card = h('div', { class: 'card', data: { key } });
  card._key = key;
  const inputs = FIELDS.map(([f, label]) => {
    const input = h('input', { type: 'text', spellcheck: 'false', data: { f }, on: {
      change: () => bulkSet(card, f, input),
      keydown: e => { if (e.key === 'Escape') { syncFields(card); input.blur(); } },
    } });
    return h('label', {}, label, input);
  });
  card.append(
    h('div', { class: 'side' },
      h('div', { class: 'cover' }),
      h('div', { class: 'cover-meta' }),
      h('button', { class: 'auto', text: 'Auto', title: 'Fill album artist, unify cover art, tidy track and disc numbers', on: { click: () => autoAlbum(key) } })),
    h('div', { class: 'body' },
      h('div', { class: 'fields' }, inputs),
      h('div', { class: 'tbl' })),
    h('button', { class: 'close', text: '×', title: 'Remove album from list', on: { click: () => removeAlbum(key) } }),
  );
  updateCard(card);
  return card;
}

function updateCard(card) {
  const list = S.groups.get(card._key) || [];
  const tbl = $('.tbl', card);
  const left = tbl.scrollLeft;
  tbl.replaceChildren(buildHeader(), ...sortRows(list).map(buildRow));
  tbl.scrollLeft = left;
  syncFields(card);
  updateCover(card, list);
}

function syncFields(card) {
  const list = S.groups.get(card._key) || [];
  for (const input of card.querySelectorAll('.fields input')) {
    if (document.activeElement === input && input._busy) continue;
    const f = input.dataset.f;
    const vals = new Set(list.map(t => val(t, f)));
    const mixed = vals.size > 1;
    input.value = mixed ? '' : [...vals][0] ?? '';
    input.placeholder = mixed ? '<keep>' : '';
    input.classList.toggle('dirty', list.some(t => f in t.ed));
  }
}

function buildHeader() {
  const row = h('div', { class: 'tr th' });
  for (const id of visible()) {
    const sorted = S.sort.id === id;
    row.append(h('div', { class: 'h' + (sorted ? ' sorted' : ''), data: { id } },
      COL[id].label,
      sorted ? h('span', { class: 'arrow', text: S.sort.dir > 0 ? '▲' : '▼' }) : null,
      h('span', { class: 'grip' })));
  }
  return row;
}

function buildRow(t) {
  const row = h('div', { class: 'tr row' + (S.sel === t.path ? ' sel' : ''), data: { path: t.path } });
  for (const id of visible()) {
    const c = COL[id];
    row.append(h('div', {
      class: 'td' + (c.num ? ' num' : '') + (c.ro ? ' ro' : '') + (id in t.ed ? ' dirty' : ''),
      data: { id }, title: id === 'filename' || id === 'path' ? t.path : '', text: cellText(t, id),
    }));
  }
  return row;
}

function renderAll() {
  regroup();
  albumsEl.replaceChildren();
  S.cards.clear();
  applyTemplate();
  for (const key of sortedKeys()) {
    const card = buildCard(key);
    S.cards.set(key, card);
    albumsEl.append(card);
  }
  chrome();
}

// Refresh only the album cards touched by a change.
function refresh(keys) {
  regroup();
  const order = sortedKeys();
  for (const key of keys) {
    const exists = S.groups.has(key), el = S.cards.get(key);
    if (!exists && el) { el.remove(); S.cards.delete(key); }
    else if (exists && !el) {
      const card = buildCard(key);
      S.cards.set(key, card);
      const next = order.slice(order.indexOf(key) + 1).map(k => S.cards.get(k)).find(Boolean);
      albumsEl.insertBefore(card, next || null);
    } else if (exists) updateCard(el);
  }
  chrome();
}
function mutate(list, fn) {
  const before = list.map(keyOf);
  fn();
  refresh(new Set([...before, ...list.map(keyOf)]));
}

function chrome() {
  const n = S.tracks.size, a = S.groups.size;
  document.body.classList.toggle('is-empty', n === 0);
  $('#stats').textContent = n ? `${n} track${n === 1 ? '' : 's'} · ${a} album${a === 1 ? '' : 's'}` : '';
  const dirty = [...S.tracks.values()].filter(isDirty).length;
  const save = $('#btn-save');
  save.disabled = dirty === 0;
  save.textContent = dirty ? `Save (${dirty})` : 'Save';
  const clr = $('#btn-clear');
  clr.hidden = n === 0;
  if (!S.armed) clr.textContent = 'Clear';
}

/* ───────────────────────── editing ───────────────────────── */
function bulkSet(card, f, input) {
  const list = S.groups.get(card._key) || [];
  const v = input.value.trim();
  const mixed = new Set(list.map(t => val(t, f))).size > 1;
  if (v === '' && mixed) return;                       // <keep>
  mutate(list, () => list.forEach(t => setVal(t, f, v)));
}

function startEdit(td) {
  const row = td.closest('.row'), id = td.dataset.id, path = row.dataset.path;
  const t = S.tracks.get(path);
  if (!t || COL[id].ro) return;
  const input = h('input', { type: 'text', spellcheck: 'false' });
  input.value = val(t, id);
  td.replaceChildren(input);
  td.classList.remove('dirty');
  input.focus(); input.select();
  let done = false;
  const finish = (commit, dir = 0) => {
    if (done) return; done = true;
    let nextId = null;
    if (dir) {
      const cols = visible().filter(c => !COL[c].ro);
      nextId = cols[cols.indexOf(id) + dir] ?? null;
    }
    if (commit) {
      const v = input.value.trim();
      const ok = (id !== 'track' && id !== 'disc') || /^\d*(\s*\/\s*\d*)?$/.test(v);
      if (ok) mutate([t], () => setVal(t, id, v.replace(/\s+/g, '')));
      else { toast('Use a number, or number/total'); mutate([t], () => {}); }
    } else mutate([t], () => {});
    if (nextId) {
      const next = [...albumsEl.querySelectorAll('.row')].find(r => r.dataset.path === path)?.querySelector(`.td[data-id="${nextId}"]`);
      if (next) startEdit(next);
    }
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
    else if (e.key === 'Tab') { e.preventDefault(); finish(true, e.shiftKey ? -1 : 1); }
  });
  input.addEventListener('blur', () => finish(true));
}

function removeAlbum(key) {
  for (const t of (S.groups.get(key) || [])) S.tracks.delete(t.path);
  refresh(new Set([key]));
}

/* ───────────────────────── Auto ───────────────────────── */
const padN = (n, w) => String(n).padStart(w, '0');
function autoAlbum(key) {
  const list = S.groups.get(key) || [];
  const snap = () => list.map(t => JSON.stringify([t.ed, t.coverFrom]));
  const before = snap();
  mutate(list, () => {
    // 1. Album artist: one track has it → every track gets it.
    const counts = new Map();
    list.forEach(t => { const v = val(t, 'album_artist').trim(); if (v) counts.set(v, (counts.get(v) || 0) + 1); });
    if (counts.size) {
      const aa = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      list.forEach(t => { if (!val(t, 'album_artist').trim()) setVal(t, 'album_artist', aa); });
    }

    // 2. Cover: largest embedded image wins, copied to every lower-resolution (or missing) one.
    const best = bestCoverTrack(list);
    if (best) {
      const bp = pixels(cov(best)), src = best.coverFrom || best.path;
      list.forEach(t => { if (t.path !== src && pixels(cov(t)) < bp) t.coverFrom = src; });
    }

    // 3. Track numbers: 01, 02 … and "of" = highest track number on that disc.
    const rows = list.map(t => ({ t, tr: pair(val(t, 'track')), ds: pair(val(t, 'disc')) }));
    const maxTrack = Math.max(0, ...rows.map(r => r.tr.n || 0));
    const w = Math.max(2, String(maxTrack).length);
    const perDisc = new Map();
    rows.forEach(r => { if (r.tr.n != null) { const d = r.ds.n ?? 1; perDisc.set(d, Math.max(perDisc.get(d) || 0, r.tr.n)); } });
    rows.forEach(r => {
      if (r.tr.n == null) return;
      setVal(r.t, 'track', `${padN(r.tr.n, w)}/${padN(perDisc.get(r.ds.n ?? 1), w)}`);
    });

    // 4. Disc numbers: 01, 02 … and, when there are several discs, "of" = disc count.
    const maxDisc = Math.max(0, ...rows.map(r => r.ds.n || 0));
    const wd = Math.max(2, String(maxDisc).length);
    rows.forEach(r => {
      if (r.ds.n == null) return;
      const total = maxDisc > 1 ? maxDisc : r.ds.t;
      setVal(r.t, 'disc', total ? `${padN(r.ds.n, wd)}/${padN(total, wd)}` : padN(r.ds.n, wd));
    });
  });
  const after = snap();
  const n = list.filter((_, i) => before[i] !== after[i]).length;
  toast(n ? `Auto: ${n} track${n === 1 ? '' : 's'} updated — Save to write` : 'Auto: already tidy');
}

/* ───────────────────────── load / save ───────────────────────── */
async function addPaths(paths) {
  if (!paths || !paths.length) return;
  let infos;
  try { infos = await invoke('load_paths', { paths }); }
  catch (e) { toast(`Could not read files: ${e}`); return; }
  const fresh = infos.filter(i => !S.tracks.has(i.path));
  if (!fresh.length) { toast(infos.length ? 'Already in the list' : 'No supported audio files found'); return; }
  fresh.forEach(i => S.tracks.set(i.path, mkTrack(i)));
  renderAll();
}

async function saveAll() {
  const dirty = [...S.tracks.values()].filter(isDirty);
  if (!dirty.length) return;
  const btn = $('#btn-save'); btn.disabled = true; btn.textContent = 'Saving…';
  const split = s => { const [a, b = ''] = String(s || '').split('/'); return [a.trim(), b.trim()]; };
  const edits = dirty.map(t => {
    const [tn, tt] = split(val(t, 'track')), [dn, dt] = split(val(t, 'disc'));
    const fields = { track: tn, track_total: tt, disc: dn, disc_total: dt };
    ['title', 'artist', 'album', 'album_artist', 'genre', 'sort_album', 'comment', 'composer', 'year']
      .forEach(f => { fields[f] = val(t, f); });
    return { path: t.path, fields, cover_from: t.coverFrom };
  });
  let results;
  try { results = await invoke('save_tracks', { edits }); }
  catch (e) { toast(`Save failed: ${e}`); chrome(); return; }
  let ok = 0; const failed = [];
  const keys = new Set();
  for (const r of results) {
    const t = S.tracks.get(r.path); if (!t) continue;
    keys.add(keyOf(t));
    if (r.ok) {
      ok++;
      coverCache.delete(r.path);
      if (r.track) { const fresh = mkTrack(r.track); t.base = fresh.base; t.ed = {}; t.coverFrom = null; }
      else { t.ed = {}; t.coverFrom = null; }
      keys.add(keyOf(t));
    } else failed.push(`${t.base.filename}: ${r.error}`);
  }
  S.cards.forEach(c => { c._cover = undefined; });
  refresh(keys);
  toast(failed.length ? `Saved ${ok}, ${failed.length} failed — ${failed[0]}` : `Saved ${ok} track${ok === 1 ? '' : 's'}`, failed.length ? 7000 : 2500);
}

function clearAll() {
  const dirty = [...S.tracks.values()].some(isDirty);
  const btn = $('#btn-clear');
  if (dirty && !S.armed) {
    S.armed = true; btn.textContent = 'Discard changes?'; btn.classList.add('armed');
    setTimeout(() => { S.armed = false; btn.classList.remove('armed'); chrome(); }, 3000);
    return;
  }
  S.armed = false; btn.classList.remove('armed');
  S.tracks.clear(); coverCache.clear(); S.sel = null;
  renderAll();
}

async function browse() {
  try {
    const picked = await TAURI.dialog.open({ multiple: true, filters: [{ name: 'Audio', extensions: EXT }] });
    if (picked) addPaths(Array.isArray(picked) ? picked : [picked]);
  } catch (e) { toast(`Could not open dialog: ${e}`); }
}

/* ───────────────────────── toast & menu ───────────────────────── */
let toastTimer;
function toast(msg, ms = 2800) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

const menu = $('#menu');
function openMenu(x, y) {
  menu.replaceChildren(...[...COLS].sort((a, b) => a.label.localeCompare(b.label)).map(c => {
    const on = !S.cols.hidden.includes(c.id);
    return h('div', { on: { click: () => {
      if (on && visible().length === 1) return;
      S.cols.hidden = on ? [...S.cols.hidden, c.id] : S.cols.hidden.filter(i => i !== c.id);
      saveCols(); closeMenu(); renderAll();
    } } }, h('span', { class: 'tick', text: on ? '✓' : '' }), c.label);
  }));
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
}
function closeMenu() { menu.hidden = true; }

/* ───────────────────────── header interactions ───────────────────────── */
function autosize(id) {
  let max = COL[id].label.length + 3;
  for (const t of S.tracks.values()) max = Math.max(max, cellText(t, id).length);
  S.cols.widths[id] = Math.max(44, Math.min(520, Math.round(max * 7 + 22)));
  saveCols(); applyTemplate();
}

albumsEl.addEventListener('mousedown', e => {
  const hd = e.target.closest('.th .h');
  if (e.button !== 0 || !hd) return;
  const id = hd.dataset.id;
  if (e.target.classList.contains('grip')) {            // resize
    e.preventDefault();
    const x0 = e.clientX, w0 = colW(id);
    const move = ev => { S.cols.widths[id] = Math.max(40, w0 + ev.clientX - x0); applyTemplate(); };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); saveCols(); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
    return;
  }
  e.preventDefault();                                   // click = sort, drag = reorder
  const x0 = e.clientX, header = hd.closest('.th');
  let dragging = false, target = null, side = 'before';
  const clear = () => header.querySelectorAll('.drop-before,.drop-after').forEach(n => n.classList.remove('drop-before', 'drop-after'));
  const move = ev => {
    if (!dragging && Math.abs(ev.clientX - x0) > 5) { dragging = true; document.body.classList.add('dragcol'); }
    if (!dragging) return;
    clear();
    const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.th .h');
    if (el && el.closest('.th') === header && el.dataset.id !== id) {
      const r = el.getBoundingClientRect();
      side = ev.clientX < r.left + r.width / 2 ? 'before' : 'after';
      target = el.dataset.id;
      el.classList.add(side === 'before' ? 'drop-before' : 'drop-after');
    } else target = null;
  };
  const up = () => {
    removeEventListener('mousemove', move); removeEventListener('mouseup', up);
    document.body.classList.remove('dragcol'); clear();
    if (!dragging) {
      S.sort = S.sort.id === id ? { id, dir: -S.sort.dir } : { id, dir: 1 };
      S.cards.forEach(updateCard);
    } else if (target) {
      const order = S.cols.order.filter(i => i !== id);
      const at = order.indexOf(target) + (side === 'after' ? 1 : 0);
      order.splice(at, 0, id);
      S.cols.order = order; saveCols(); renderAll();
    }
  };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
});

albumsEl.addEventListener('dblclick', e => {
  const grip = e.target.closest('.grip');
  if (grip) { autosize(grip.closest('.h').dataset.id); return; }
  const td = e.target.closest('.row .td');
  if (td && !td.querySelector('input')) startEdit(td);
});
albumsEl.addEventListener('click', e => {
  const row = e.target.closest('.row');
  if (!row) return;
  S.sel = row.dataset.path;
  albumsEl.querySelectorAll('.row.sel').forEach(r => r.classList.remove('sel'));
  row.classList.add('sel');
});
albumsEl.addEventListener('contextmenu', e => {
  if (e.target.closest('.th')) { e.preventDefault(); openMenu(e.clientX, e.clientY); }
});
addEventListener('mousedown', e => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
addEventListener('keydown', e => {
  if (e.key === 'Escape') closeMenu();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveAll(); }
});
addEventListener('contextmenu', e => { if (!e.target.closest('.th') && !e.target.closest('input')) e.preventDefault(); });

/* ───────────────────────── wiring ───────────────────────── */
$('#btn-add').addEventListener('click', browse);
$('#btn-clear').addEventListener('click', clearAll);
$('#btn-save').addEventListener('click', saveAll);
$('.drop-target').addEventListener('click', browse);

if (TAURI) {
  TAURI.event.listen('files-dropped', e => addPaths(e.payload));
  TAURI.event.listen('drag-state', e => document.body.classList.toggle('dragging', !!e.payload));
}
window.__musictag = { addPaths, S };   // handy for debugging / UI tests
renderAll();
})();
