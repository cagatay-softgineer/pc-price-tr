import { flagOutliers, formatTL, median } from '/lib/text.js';
import { linearScale, linePath, niceTicks, stepPath, timeTicks } from '/lib/chart.js';
import { lastChange } from '/lib/watch.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const FLAG_LABEL = { accessory: 'accessory', system: 'laptop / prebuilt', outlier: 'suspiciously cheap' };
const EXAMPLES = ['rtx 4060 -ti', 'ryzen 7 7800x3d', '32gb ddr5 6000', 'nvme 1tb'];

const store = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode: keep working in memory */
    }
  },
};

const state = {
  sites: [],
  disabled: new Set(store.get('pcprice.disabled', [])),
  status: {}, // site id → { state, text }
  offers: [],
  query: '',
  build: store.get('pcprice.build', []),
  recent: store.get('pcprice.recent', []),
  sort: { key: 'price', dir: 1 },
  sel: -1, // index into the visible list
  list: [], // the visible list from the last render
  ticks: new Map(), // price-spread marks, kept between renders so they can move
  seen: new Map(), // offer key → when it first appeared (only new ones animate in)
  lastAdded: null,
  hist: null, // what the history panel shows: { mode: 'query' | 'offer', title, pts, seen }
  histBase: null, // the query's own series, kept while one offer's history is open
  histLoading: false,
  watch: store.get('pcprice.watch', []), // [{ q, sites, addedAt }]: searches whose lowest price you follow
  watchInfo: new Map(), // q → lastChange() of its series
  checking: false,
};

const enabledSites = () => state.sites.filter((s) => !state.disabled.has(s.id)).map((s) => s.id);

/* ---------- motion helpers ---------- */

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Restart a one-shot CSS animation class on an element. */
function replay(el, cls, ms) {
  if (reducedMotion()) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

/** Count a number to its new value (a changing price should be seen to change). */
function tween(el, to, fmt) {
  cancelAnimationFrame(el._raf);
  const from = el._cur;
  el._cur = to;
  if (from === undefined || from === to || reducedMotion()) {
    el.textContent = fmt(to);
    return;
  }
  const t0 = performance.now();
  const dur = 320;
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    el.textContent = fmt(from + (to - from) * (1 - (1 - p) ** 3));
    if (p < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

/** Stable colour per store: a hue from its id. */
function hue(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/** Run one search over SSE; resolves with the final offer list. */
function runSearch(q, { fresh = false, deep = false, sites = enabledSites(), onSite } = {}) {
  const url = `/api/search?q=${encodeURIComponent(q)}&sites=${sites.join(',')}${fresh ? '&fresh=1' : ''}${deep ? '&deep=1' : ''}`;
  return new Promise((resolve, reject) => {
    const es = new EventSource(url);
    es.addEventListener('site', (e) => onSite?.(JSON.parse(e.data)));
    es.addEventListener('done', (e) => {
      es.close();
      resolve(JSON.parse(e.data).offers);
    });
    es.addEventListener('fail', (e) => {
      es.close();
      reject(new Error(JSON.parse(e.data).error));
    });
    es.onerror = () => {
      es.close();
      reject(new Error('Connection to the local server was lost'));
    };
  });
}

function remember(q) {
  state.recent = [q, ...state.recent.filter((r) => r.toLowerCase() !== q.toLowerCase())].slice(0, 8);
  store.set('pcprice.recent', state.recent);
}

async function search(q, fresh) {
  state.query = q;
  state.offers = [];
  state.status = {};
  state.sel = -1;
  state.ticks.clear();
  state.seen.clear();
  state.bestKey = null;
  state.hist = state.histBase = null;
  state.histLoading = true;
  $('#track').innerHTML = '';
  $('#q').value = q;
  remember(q);
  renderRecent();
  history.replaceState(null, '', `?q=${encodeURIComponent(q)}`);
  for (const s of state.sites) if (!state.disabled.has(s.id)) state.status[s.id] = { state: 'loading', text: '' };
  $('#search button[type=submit]').disabled = true;
  render();
  const partial = [];
  try {
    state.offers = await runSearch(q, {
      fresh,
      deep: $('#deep').checked,
      onSite: (r) => {
        const text = r.status === 'ok' ? `${r.offers.length}${r.warning ? ' !' : ''}` : r.status;
        const detail = `${r.found} found, ${r.offers.length} matched · ${(r.ms / 1000).toFixed(1)}s${r.cached ? ' (cached)' : ''}`;
        state.status[r.site] = {
          just: true,
          state: r.warning ? 'warn' : r.status,
          text,
          zero: r.status === 'ok' && !r.offers.length,
          title: r.error || (r.warning ? `${r.warning} (${detail})` : detail),
        };
        partial.push(...r.offers);
        state.offers = flagOutliers(partial).sort((a, b) => a.price - b.price);
        render();
      },
    });
  } catch (e) {
    toast(e.message);
  } finally {
    $('#search button[type=submit]').disabled = false;
    render();
    loadHistory(q);
  }
}

/* ---------- price history ---------- */

const DATE = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' });
const DATETIME = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const COMPACT_TL = (v) => `₺${new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 }).format(v)}`;
const HIST = { h: 220, m: { l: 64, r: 22, t: 18, b: 28 } };

/** The query's own series: the lowest price of each past search. */
async function loadHistory(q) {
  let points = null;
  try {
    const r = await fetch(`/api/history?q=${encodeURIComponent(q)}&sites=${enabledSites().join(',')}`);
    if (r.ok) points = (await r.json()).points;
  } catch {
    /* history is optional: the page works without it */
  }
  if (state.query !== q) return; // a newer search took over
  state.histLoading = false;
  state.hist = state.histBase = points?.length
    ? {
        mode: 'query',
        title: `Lowest price for “${q}”`,
        pts: points.map((p) => ({ t: p.t, v: p.min, med: p.median, n: p.n, best: p.best, failed: p.failed })),
      }
    : null;
  renderHistory(true);
  if (points && isWatched(q)) {
    state.watchInfo.set(q, lastChange(points));
    renderWatch();
  }
}

async function showOfferHistory(o) {
  if (!o) return;
  try {
    const r = await fetch(`/api/history?url=${encodeURIComponent(o.url)}`);
    if (!r.ok) throw new Error('no history');
    const e = await r.json();
    state.hist = { mode: 'offer', title: `${o.siteName} · ${o.title.slice(0, 70)}`, pts: e.points.map(([t, v]) => ({ t, v })), seen: e.seen };
    renderHistory(true);
    $('#history').scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  } catch {
    toast('No price history for this offer yet');
  }
}

function renderHistory(animate = false) {
  const sec = $('#history');
  const h = state.hist;
  if (!h) {
    sec.hidden = !state.histLoading;
    sec.classList.toggle('skel', state.histLoading);
    $('#hchart').innerHTML = '';
    $('#hNote').textContent = state.histLoading ? 'Waiting for stores…' : '';
    $('#hTitle').textContent = 'Price history';
    $('#hClose').hidden = true;
    $('#hMed').closest('label').hidden = true;
    $('#hWatch').hidden = true;
    return;
  }
  if (sec.hidden || sec.classList.contains('skel')) {
    sec.hidden = false;
    sec.classList.remove('skel');
    replay(sec, 'enter', 700);
  }
  $('#hTitle').textContent = h.title;
  $('#hClose').hidden = h.mode !== 'offer' || !state.histBase;
  $('#hMed').closest('label').hidden = h.mode !== 'query' || h.pts.length < 2;
  renderWatchButton();
  drawHistory(animate);
}

function renderWatchButton() {
  const b = $('#hWatch');
  b.hidden = !state.hist || state.hist.mode !== 'query';
  const on = isWatched(state.query);
  b.setAttribute('aria-pressed', String(on));
  b.textContent = on ? 'Watching' : 'Watch';
  b.title = on ? 'Stop watching this search' : 'Follow this search’s lowest price in your watchlist';
}

function drawHistory(animate = false) {
  const h = state.hist;
  if (!h) return;
  const box = $('#hchart');
  const W = Math.max(280, Math.round(box.clientWidth));
  const { h: H, m } = HIST;
  const { pts } = h;
  const showMed = h.mode === 'query' && $('#hMed').checked;
  let t0 = pts[0].t;
  let t1 = h.mode === 'offer' ? Math.max(h.seen, pts.at(-1).t) : pts.at(-1).t;
  if (t1 - t0 < 3600_000) {
    t0 -= 12 * 3600_000; // too little time to draw a line: centre what there is
    t1 += 12 * 3600_000;
  }
  const values = pts.map((p) => p.v).concat(showMed ? pts.map((p) => p.med) : []);
  const yTicks = niceTicks(Math.min(...values), Math.max(...values), 4);
  const x = linearScale([t0, t1], [m.l, W - m.r]);
  const y = linearScale([yTicks[0], yTicks.at(-1)], [H - m.b, m.t]);
  const xy = pts.map((p) => [x(p.t), y(p.v)]);
  const last = pts.at(-1);
  const line =
    h.mode === 'offer'
      ? `<path class="hline" d="${stepPath(xy, x(t1))}"/>`
      : xy.length > 1
        ? `<path class="hline" d="${linePath(xy)}"/>`
        : '';
  const med = showMed
    ? `<path class="hmed" d="${linePath(pts.map((p) => [x(p.t), y(p.med)]))}"/><text class="hlbl" x="${W - m.r}" y="${y(last.med) - 6}" text-anchor="end">median</text>`
    : '';
  // A hollow dot: some store did not answer that time, so the low may be too high.
  const dots = xy.map(([cx, cy], i) => `<circle class="hdot${pts[i].failed?.length ? ' miss' : ''}" cx="${cx}" cy="${cy}" r="4"/>`).join('');
  const xTicks = timeTicks(t0, t1, Math.max(2, Math.floor(W / 110)));
  const lowest = Math.min(...pts.map((p) => p.v));
  const summary =
    pts.length > 1
      ? `${h.title}: ${pts.length} observations from ${COMPACT_TL(pts[0].v)} on ${DATE.format(pts[0].t)} to ${COMPACT_TL(last.v)} on ${DATE.format(last.t)}, lowest ${COMPACT_TL(lowest)}`
      : `${h.title}: ${COMPACT_TL(last.v)} on ${DATE.format(last.t)}, a single observation so far`;
  const endX = xy.at(-1)[0];
  box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(summary)}">
    ${yTicks.map((v) => `<line class="hgrid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="hax" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${COMPACT_TL(v)}</text>`).join('')}
    ${xTicks.map((t) => `<text class="hax" x="${x(t)}" y="${H - 8}" text-anchor="middle">${DATE.format(t)}</text>`).join('')}
    ${med}${line}${dots}
    <text class="hval" x="${endX}" y="${xy.at(-1)[1] - 11}" text-anchor="${endX > W - 70 ? 'end' : 'middle'}">${COMPACT_TL(last.v)}</text>
    <line class="hcross" y1="${m.t}" y2="${H - m.b}" hidden/><circle class="hring" r="6" hidden/>
    <rect class="hhit" x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}"/>
  </svg>`;

  const path = box.querySelector('.hline');
  if (path && animate) {
    path.style.setProperty('--len', Math.ceil(path.getTotalLength()));
    replay(path, 'draw', 520);
  }
  const msg = pts.length > 1 ? '' : h.mode === 'query' ? 'History starts with this search. Search again another day to see how prices move.' : `Price has not changed since ${DATE.format(pts[0].t)}.`;
  if (msg) box.insertAdjacentHTML('beforeend', `<p class="hmsg">${esc(msg)}</p>`);
  $('#hNote').textContent = `${pts.length} ${pts.length === 1 ? 'observation' : 'observations'}${pts.length > 1 ? ` · lowest ${COMPACT_TL(lowest)}` : ''}`;

  const siteName = (id) => state.sites.find((s) => s.id === id)?.name ?? id;
  const query = h.mode === 'query';
  const missing = (p) => (p.failed?.length ? p.failed.map(siteName).join(', ') : '');
  const anyMissing = query && pts.some((p) => p.failed?.length);
  $('#hdata').innerHTML = `<table><thead><tr><th>When</th><th class="num">${query ? 'Lowest' : 'Price'}</th>${query ? '<th class="num">Median</th><th>Cheapest at</th><th class="num">Offers</th>' : ''}${anyMissing ? '<th>No answer from</th>' : ''}</tr></thead><tbody>${[...pts]
    .reverse()
    .map((p) => `<tr><td>${DATETIME.format(p.t)}</td><td class="num">${formatTL(p.v)}</td>${query ? `<td class="num">${formatTL(p.med)}</td><td>${esc(p.best ? siteName(p.best.site) : '')}</td><td class="num">${p.n}</td>` : ''}${anyMissing ? `<td>${esc(missing(p))}</td>` : ''}</tr>`)
    .join('')}</tbody></table>`;
  if (anyMissing) $('#hNote').textContent += ' · hollow dots: a store did not answer';

  const svg = box.querySelector('svg');
  const cross = svg.querySelector('.hcross');
  const ring = svg.querySelector('.hring');
  const tip = $('#htip');
  const hit = svg.querySelector('.hhit');
  hit.onpointermove = (e) => {
    const rect = svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let k = 0;
    for (let i = 1; i < xy.length; i++) if (Math.abs(xy[i][0] - px) < Math.abs(xy[k][0] - px)) k = i;
    const p = pts[k];
    cross.setAttribute('x1', xy[k][0]);
    cross.setAttribute('x2', xy[k][0]);
    ring.setAttribute('cx', xy[k][0]);
    ring.setAttribute('cy', xy[k][1]);
    cross.hidden = ring.hidden = false;
    tip.innerHTML = `<b>${formatTL(p.v)}</b>${query && p.best ? ` · ${esc(siteName(p.best.site))}<br>${esc(p.best.title.slice(0, 70))}` : ''}<br>${DATETIME.format(p.t)}${p.n ? ` · ${p.n} offers` : ''}${p.failed?.length ? `<br><span class="miss">No answer from ${esc(missing(p))}</span>` : ''}`;
    tip.hidden = false;
    const sec = $('#history').getBoundingClientRect();
    tip.style.left = `${Math.max(130, Math.min(sec.width - 130, rect.left - sec.left + xy[k][0]))}px`;
    tip.style.top = `${rect.top - sec.top + Math.max(4, xy[k][1] - 74)}px`;
  };
  hit.onpointerleave = () => {
    cross.hidden = ring.hidden = true;
    tip.hidden = true;
  };
}

/* ---------- filtering and sorting ---------- */

function parseMoney(v) {
  const n = Number(String(v).replace(/[^\d,]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function visibleOffers() {
  const showHidden = $('#showHidden').checked;
  const showAgg = $('#showAgg').checked;
  const onlyCash = $('#onlyCash').checked;
  const words = $('#refine').value.toLocaleLowerCase('tr').split(/\s+/).filter(Boolean);
  const want = words.filter((w) => !w.startsWith('-'));
  const skip = words.filter((w) => w.startsWith('-') && w.length > 1).map((w) => w.slice(1));
  const min = parseMoney($('#pmin').value);
  const max = parseMoney($('#pmax').value);
  const list = state.offers.filter((o) => {
    if (!showHidden && o.flag) return false;
    if (!showAgg && o.kind === 'aggregator') return false;
    if (onlyCash && !o.installment?.cashPrice) return false;
    if (min && o.price < min) return false;
    if (max && o.price > max) return false;
    if (want.length || skip.length) {
      const hay = `${o.title} ${o.siteName}`.toLocaleLowerCase('tr');
      if (!want.every((w) => hay.includes(w)) || skip.some((w) => hay.includes(w))) return false;
    }
    return true;
  });
  const { key, dir } = state.sort;
  const cmp = {
    price: (a, b) => a.price - b.price,
    store: (a, b) => a.siteName.localeCompare(b.siteName, 'tr') || a.price - b.price,
    title: (a, b) => a.title.localeCompare(b.title, 'tr') || a.price - b.price,
  }[key];
  return list.sort((a, b) => cmp(a, b) * dir);
}

/** "Peşin fiyatına 9 taksit" when the store promises the cash price, else a plain "9 taksit". */
function installmentLabel(inst) {
  if (!inst) return '';
  const n = inst.months ? `${inst.months} taksit` : 'taksit';
  return inst.cashPrice ? `Peşin fiyatına ${n}` : n;
}

/* ---------- rendering ---------- */

/** Store chips are built once and updated in place, so a chip can flash when its store answers. */
function renderStores() {
  const box = $('#stores');
  if (box.children.length !== state.sites.length) {
    box.innerHTML = state.sites
      .map((s) => `<button type="button" class="store" style="--h:${hue(s.id)}" data-id="${s.id}"><i class="dot" aria-hidden="true"></i><span class="nm">${esc(s.name)}</span> <span class="n"></span></button>`)
      .join('');
  }
  for (const el of box.children) {
    const st = state.status[el.dataset.id];
    const off = state.disabled.has(el.dataset.id);
    el.setAttribute('aria-pressed', String(!off));
    el.dataset.state = st?.state ?? '';
    el.classList.toggle('off', off);
    el.classList.toggle('zero', !!st?.zero);
    el.title = off ? 'Click to include' : st?.title ?? 'Click to skip this store';
    el.querySelector('.n').textContent = st?.text ?? '';
    if (st?.just) {
      st.just = false;
      replay(el, 'just', 800);
    }
  }
}

function renderProgress() {
  const ids = state.sites.filter((s) => !state.disabled.has(s.id)).map((s) => s.id);
  const searching = ids.some((id) => state.status[id]);
  const done = ids.filter((id) => state.status[id] && state.status[id].state !== 'loading').length;
  const pct = searching && ids.length ? Math.round((done / ids.length) * 100) : 0;
  const bar = $('#progress');
  bar.firstElementChild.style.width = `${pct}%`;
  bar.setAttribute('aria-valuenow', String(pct));
  bar.classList.toggle('done', !searching || pct === 100);
}

/**
 * Best/median/highest over the real stores' offers. Akakçe/Epey rows summarise
 * other stores, so they only count when no store row is shown (as in the history).
 */
function computeStats(list) {
  const counted = list.map((o, i) => ({ o, i })).filter(({ o }) => !o.flag);
  const stores = counted.filter(({ o }) => o.kind !== 'aggregator');
  const pool = stores.length ? stores : counted;
  if (!pool.length) return null;
  const prices = pool.map(({ o }) => o.price).sort((a, b) => a - b);
  const best = pool.reduce((m, p) => (p.o.price < m.o.price ? p : m));
  return {
    pool,
    prices,
    best: best.o,
    bestIndex: best.i,
    med: median(prices),
    max: prices[prices.length - 1],
    stores: new Set(pool.map(({ o }) => o.site)).size,
  };
}

/** The four stat cards are built once; their numbers count to new values as stores report. */
function renderStats(stats, list, loading) {
  const el = $('#stats');
  if (!el.firstElementChild) {
    el.innerHTML = ['Best price', 'Median', 'Highest', 'Offers']
      .map((k, i) => `<div class="stat${i ? '' : ' hero'}" style="--k:${i}"><span class="k">${k}</span><b data-f="${i}"></b><span class="s" data-s="${i}"></span></div>`)
      .join('');
  }
  if (!stats) {
    // While stores are still answering, hold the space so the page doesn't jump when numbers arrive.
    el.querySelectorAll('b').forEach((b) => {
      b._cur = undefined;
      b.textContent = '';
    });
    el.querySelectorAll('.s').forEach((s) => (s.textContent = ''));
    el.hidden = !loading;
    el.classList.toggle('skel', !!loading);
    return;
  }
  if (el.hidden || el.classList.contains('skel')) {
    el.hidden = false;
    el.classList.remove('skel');
    replay(el, 'enter', 600);
  }
  const f = (i) => el.querySelector(`[data-f="${i}"]`);
  const s = (i) => el.querySelector(`[data-s="${i}"]`);
  const over = stats.max > stats.best.price ? Math.round((stats.max / stats.best.price - 1) * 100) : 0;
  const hidden = state.offers.length - list.length;
  tween(f(0), stats.best.price, formatTL);
  tween(f(1), stats.med, formatTL);
  tween(f(2), stats.max, formatTL);
  tween(f(3), stats.pool.length, (n) => String(Math.round(n)));
  s(0).innerHTML = `<a href="${esc(stats.best.url)}" target="_blank" rel="noopener">${esc(stats.best.siteName)}</a> · ${esc(stats.best.title.slice(0, 60))}`;
  s(1).textContent = stats.med > stats.best.price ? `best is ${Math.round((1 - stats.best.price / stats.med) * 100)}% below` : 'best is the median';
  s(2).textContent = over ? `+${over}% over the best` : 'same as the best';
  s(3).textContent = `from ${stats.stores} ${stats.stores === 1 ? 'store' : 'stores'}${hidden > 0 ? ` · ${hidden} not shown` : ''}`;
}

function renderLadder(stats, loading) {
  const sec = $('#ladder');
  if (!stats || stats.pool.length < 2) {
    sec.hidden = !loading;
    sec.classList.toggle('skel', !!loading);
    $('#ladderNote').textContent = loading ? 'Waiting for stores…' : '';
    $('#axis').innerHTML = '';
    return;
  }
  if (sec.hidden || sec.classList.contains('skel')) {
    sec.hidden = false;
    sec.classList.remove('skel');
    replay(sec, 'enter', 700);
  }
  const { prices, pool } = stats;
  const lo = prices[0];
  const p90 = prices[Math.floor(0.9 * (prices.length - 1))];
  const cap = Math.max(lo + 1, Math.min(stats.max, p90 * 1.25));
  const pos = (p) => Math.min(100, ((p - lo) / (cap - lo)) * 100);
  const clipped = pool.filter(({ o }) => o.price > cap).length;
  const medPos = pos(stats.med);
  // Marks persist between renders: existing ones slide to their new place when the
  // axis rescales, new ones (a store just answered) grow in left to right.
  const track = $('#track');
  let med = track.querySelector('.med');
  if (!med) {
    med = document.createElement('div');
    med.className = 'tick med';
    med.setAttribute('aria-hidden', 'true');
    track.prepend(med);
  }
  med.style.left = `${medPos}%`;
  const want = new Map(pool.filter(({ o }) => o.price <= cap).map(({ o, i }) => [`${o.site}|${o.url}`, { o, i }]));
  for (const [key, el] of state.ticks) {
    if (want.has(key)) continue;
    el.classList.add('leave');
    setTimeout(() => el.remove(), 160);
    state.ticks.delete(key);
  }
  let fresh = 0;
  for (const [key, { o, i }] of want) {
    let el = state.ticks.get(key);
    if (!el) {
      // Marks are for the mouse; keyboard users reach every offer through the table (j / k).
      el = document.createElement('div');
      el.className = 'tick enter';
      el.style.setProperty('--h', hue(o.site));
      el.style.setProperty('--d', `${Math.min(fresh++, 12) * 22}ms`);
      track.append(el);
      state.ticks.set(key, el);
    }
    el.style.left = `${pos(o.price)}%`;
    el.dataset.i = i;
    el.classList.toggle('best', i === stats.bestIndex);
    el.classList.toggle('sel', i === state.sel);
    if (i === stats.bestIndex && state.bestKey !== key) {
      if (state.bestKey) replay(el, 'pulse', 760); // only when it replaces an earlier best, not on the first one
      state.bestKey = key;
    }
  }
  let more = track.querySelector('.more');
  if (clipped) {
    if (!more) {
      more = document.createElement('span');
      more.className = 'more';
      track.append(more);
    }
    more.textContent = `+${clipped}`;
    more.title = `${clipped} offers cost more than ${formatTL(cap)}`;
  } else more?.remove();
  $('#axis').innerHTML =
    `<span class="l">${formatTL(lo)}</span>` +
    (medPos > 14 && medPos < 86 ? `<span class="m" style="left:${medPos}%">median ${formatTL(stats.med)}</span>` : '') +
    `<span class="r">${clipped ? `≥ ${formatTL(cap)}` : formatTL(stats.max)}</span>`;
  $('#track').setAttribute('aria-label', `Price spread: ${pool.length} offers from ${formatTL(lo)} to ${formatTL(stats.max)}, median ${formatTL(stats.med)}`);
  $('#ladderNote').textContent = `${pool.length} offers, one mark each${clipped ? ` · ${clipped} beyond the right edge` : ''}`;
}

function renderBest(list, loading) {
  const best = new Map();
  for (const o of list) if (o.kind === 'store' && !o.flag && !best.has(o.site)) best.set(o.site, o);
  const cards = [...best.values()].sort((a, b) => a.price - b.price);
  const low = cards[0]?.price;
  if (!cards.length && loading) {
    $('#best').innerHTML = '<span class="card hold" aria-hidden="true"></span>'.repeat(4);
    return;
  }
  $('#best').innerHTML = cards
    .map(
      (o, i) =>
        `<a class="card${i === 0 ? ' top' : ''}" style="--h:${hue(o.site)}" href="${esc(o.url)}" target="_blank" rel="noopener"><span>${esc(o.siteName)}</span><b>${formatTL(o.price)}</b>${i > 0 ? `<span>+${Math.round((o.price / low - 1) * 100)}%</span>` : '<span>lowest</span>'}</a>`,
    )
    .join('');
}

/** "↓ ₺400" when this listing was cheaper or dearer at an earlier search. */
function moveBadge(o) {
  if (!o.prev) return '';
  const d = o.price - o.prev.price;
  const label = `${d < 0 ? '↓' : '↑'} ${formatTL(Math.abs(d))}`;
  const title = `Was ${formatTL(o.prev.price)} on ${DATE.format(o.prev.t)}`;
  return `<span class="badge ${d < 0 ? 'down' : 'up'}" title="${esc(title)}"><span class="sr">${d < 0 ? 'Price down' : 'Price up'} </span>${label}<span class="sr">. ${esc(title)}</span></span>`;
}

function skeletonRows() {
  const row = '<tr class="skel"><td><i style="width:70px"></i></td><td><i style="width:50px"></i></td><td><i style="width:80px"></i></td><td><i style="width:70%"></i></td><td></td></tr>';
  return row.repeat(6);
}

function renderTable() {
  const list = visibleOffers();
  state.list = list;
  if (state.sel >= list.length) state.sel = list.length - 1;
  const stats = computeStats(list);
  const loading = Object.values(state.status).some((s) => s.state === 'loading');
  const tbody = $('#table tbody');
  const bestPrice = stats?.best.price;
  let newRows = 0;
  const now = performance.now();

  tbody.innerHTML = list.length
    ? list
        .map((o, i) => {
          const badges = [
            o.kind === 'aggregator' && o.offers ? `<span class="badge">${esc(o.offers)}</span>` : '',
            o.installment ? `<span class="badge${o.installment.cashPrice ? ' cash' : ''}">${esc(installmentLabel(o.installment))}</span>` : '',
            o.flag ? `<span class="badge flag">${FLAG_LABEL[o.flag]}</span>` : '',
            moveBadge(o),
          ].join('');
          const thumb = o.image ? `<img class="thumb" src="${esc(o.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" width="36" height="36">` : '<span class="thumb none"></span>';
          const isBest = stats && i === stats.bestIndex;
          // A row animates in once. A re-render during its animation (the next store answering)
          // rebuilds the row, so it resumes from where it was via a negative delay.
          const key = `${o.site}|${o.url}`;
          let born = state.seen.get(key);
          if (!born) {
            born = { t: now, d: Math.min(newRows++, 8) * 25 };
            state.seen.set(key, born);
          }
          const left = born.d - (now - born.t);
          const animating = !reducedMotion() && left > -260;
          const cls = [isBest ? 'cheapest' : '', o.flag ? 'hidden-row' : '', i === state.sel ? 'sel' : '', animating ? 'new' : ''].join(' ');
          const delay = animating ? `style="--d:${Math.round(left)}ms"` : '';
          const diff = !o.flag && bestPrice && o.price > bestPrice ? `+${formatTL(o.price - bestPrice)}<span class="pct">+${Math.round((o.price / bestPrice - 1) * 100)}%</span>` : '';
          return `<tr class="${cls}" data-i="${i}" ${delay}>
        <td class="num">${formatTL(o.price)}</td>
        <td class="delta">${isBest ? '<span class="low">lowest</span>' : diff}</td>
        <td class="store-cell" style="--h:${hue(o.site)}">${esc(o.siteName)}</td>
        <td class="title">${thumb}<div><a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.title)}</a>${badges}</div></td>
        <td class="act"><button class="ghost hbtn" data-hist="${i}" tabindex="-1" title="Price history (h)" aria-label="${esc(`Price history of ${o.siteName} offer`)}"><svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M2 15l5-6 4 3 7-8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button class="ghost" data-add="${i}" title="Add to my build (a)" aria-label="${esc(`Add ${o.siteName} offer to my build`)}">+</button></td>
      </tr>`;
        })
        .join('')
    : loading
      ? skeletonRows()
      : '';
  tbody.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => addToBuild(list[Number(b.dataset.add)])));

  const empty = $('#empty');
  if (list.length || (loading && !list.length)) {
    empty.innerHTML = '';
  } else if (!state.query) {
    empty.innerHTML = `<p>Search for a part to compare prices across ${state.sites.length || 'all'} stores.</p><div class="ex">${EXAMPLES.map((e) => `<button type="button" data-ex="${esc(e)}">${esc(e)}</button>`).join('')}</div>`;
  } else {
    const filtered = state.offers.length && !list.length;
    empty.innerHTML = `<p>${filtered ? 'Nothing left after your filters. Clear the filter or the price range.' : 'No matching offers. Try fewer words, or remove a “-” exclusion.'}</p>`;
  }

  for (const th of document.querySelectorAll('th')) {
    const key = th.querySelector('[data-sort]')?.dataset.sort;
    if (key && key === state.sort.key) th.setAttribute('aria-sort', state.sort.dir === 1 ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  }

  const hidden = state.offers.filter((o) => o.flag).length;
  $('#summary').textContent = state.query
    ? `${list.length} offers for “${state.query}”${hidden && !$('#showHidden').checked ? ` · ${hidden} hidden (accessories, laptops/prebuilts, outliers)` : ''}${loading ? ' · still searching…' : ''}`
    : '';
  renderStats(stats, list, loading);
  renderLadder(stats, loading);
  renderBest(list, loading);
}

function select(i, { scroll = false } = {}) {
  state.sel = Math.max(-1, Math.min(i, state.list.length - 1));
  document.querySelectorAll('#table tbody tr.sel').forEach((r) => r.classList.remove('sel'));
  document.querySelectorAll('.tick.sel').forEach((r) => r.classList.remove('sel'));
  const row = document.querySelector(`#table tbody tr[data-i="${state.sel}"]`);
  row?.classList.add('sel');
  document.querySelector(`.tick[data-i="${state.sel}"]`)?.classList.add('sel');
  if (scroll && row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* ---------- build list ---------- */

function addToBuild(o) {
  if (!o) return;
  state.lastAdded = crypto.randomUUID();
  state.build.push({
    id: state.lastAdded,
    part: state.query,
    query: state.query,
    offer: { title: o.title, price: o.price, url: o.url, siteName: o.siteName },
    checkedAt: Date.now(),
  });
  saveBuild();
  toast(`Added ${o.siteName} · ${formatTL(o.price)} to your build`);
}

function saveBuild() {
  store.set('pcprice.build', state.build);
  renderBuild();
}

function renderBuild() {
  const ol = $('#buildList');
  ol.innerHTML = state.build.length
    ? state.build
        .map(
          (b) => `<li data-id="${b.id}"${b.id === state.lastAdded ? ' class="new"' : ''}>
      <div class="part"><input value="${esc(b.part)}" aria-label="Part name" /><span class="price">${formatTL(b.offer.price)}</span><button class="rm" title="Remove" aria-label="${esc(`Remove ${b.part}`)}">✕</button></div>
      <div class="meta"><a href="${esc(b.offer.url)}" target="_blank" rel="noopener">${esc(b.offer.siteName)} · ${esc(b.offer.title.slice(0, 70))}</a></div>
      <div class="meta">checked ${new Date(b.checkedAt).toLocaleString('tr-TR')}${b.gone ? ' · <b>no longer listed</b>' : ''}</div>
      ${b.alt ? `<div class="alt">Cheaper now: <a href="${esc(b.alt.url)}" target="_blank" rel="noopener">${formatTL(b.alt.price)} at ${esc(b.alt.siteName)}</a></div>` : ''}
    </li>`,
        )
        .join('')
    : '<li class="meta">Nothing yet. Use + on a result to add it.</li>';
  ol.querySelectorAll('li[data-id]').forEach((li) => {
    const item = state.build.find((b) => b.id === li.dataset.id);
    li.querySelector('.rm').onclick = () => {
      state.build = state.build.filter((b) => b !== item);
      saveBuild();
    };
    li.querySelector('input').onchange = (e) => {
      item.part = e.target.value;
      saveBuild();
    };
  });
  state.lastAdded = null;
  tween($('#buildTotal'), state.build.reduce((sum, b) => sum + b.offer.price, 0), formatTL);
}

async function copyBuild() {
  if (!state.build.length) return toast('Your build is empty');
  const total = state.build.reduce((sum, b) => sum + b.offer.price, 0);
  const text = [...state.build.map((b) => `${b.part}: ${formatTL(b.offer.price)} (${b.offer.siteName}) ${b.offer.url}`), `Total: ${formatTL(total)}`].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('Build list copied');
  } catch {
    toast('Could not copy. Your browser blocked clipboard access.');
  }
}

/**
 * Re-run each part's original search: refresh the saved offer's price if the
 * same listing is still there, and point out a cheaper non-flagged offer.
 */
async function recheckBuild() {
  const btn = $('#recheck');
  btn.disabled = true;
  try {
    for (const [i, item] of state.build.entries()) {
      btn.textContent = `Checking ${i + 1}/${state.build.length}…`;
      const offers = await runSearch(item.query, { fresh: true });
      const same = offers.find((o) => o.url === item.offer.url);
      item.gone = !same;
      if (same) item.offer.price = same.price;
      const cheaper = offers.find((o) => !o.flag && o.kind === 'store' && o.price < item.offer.price);
      item.alt = cheaper ? { price: cheaper.price, url: cheaper.url, siteName: cheaper.siteName } : null;
      item.checkedAt = Date.now();
      saveBuild();
    }
    toast(state.build.length ? 'Prices re-checked' : 'Your build is empty');
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Re-check prices';
  }
}

/* ---------- watchlist: searches whose lowest price you follow ---------- */

const sameQ = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const isWatched = (q) => state.watch.some((w) => sameQ(w.q, q));

function saveWatch() {
  store.set('pcprice.watch', state.watch);
  renderWatch();
  renderWatchButton();
}

function toggleWatch() {
  const q = state.query;
  if (!q) return;
  if (isWatched(q)) {
    state.watch = state.watch.filter((w) => !sameQ(w.q, q));
    state.watchInfo.delete(q);
    toast(`Stopped watching “${q}”`);
  } else {
    // Its own store selection is kept, so a check later reads the same series.
    const w = { q, sites: enabledSites(), addedAt: Date.now() };
    state.watch.push(w);
    toast(`Watching “${q}”. Check prices searches it again.`);
    refreshWatchInfo(w);
  }
  saveWatch();
}

async function watchPoints(w) {
  const r = await fetch(`/api/history?q=${encodeURIComponent(w.q)}&sites=${w.sites.join(',')}`);
  return r.ok ? (await r.json()).points : [];
}

async function refreshWatchInfo(w) {
  try {
    state.watchInfo.set(w.q, lastChange(await watchPoints(w)));
  } catch {
    /* the list still shows the query */
  }
  renderWatch();
}

function renderWatch() {
  const ul = $('#watchList');
  $('#checkWatch').hidden = !state.watch.length;
  if (!state.watch.length) {
    ul.innerHTML = '<li class="meta">Open a search and press <b>Watch</b> on its price history to follow its lowest price.</li>';
    return;
  }
  ul.innerHTML = state.watch
    .map((w, i) => {
      const c = state.watchInfo.get(w.q);
      const was = c?.before ? `was ${formatTL(c.before.price)} on ${DATE.format(c.before.t)}` : '';
      const move = c?.before
        ? `<span class="badge ${c.diff < 0 ? 'down' : 'up'}" title="${esc(was)}"><span class="sr">${c.diff < 0 ? 'Down' : 'Up'} </span>${c.diff < 0 ? '↓' : '↑'} ${formatTL(Math.abs(c.diff))}</span>`
        : '';
      const meta = c ? [`checked ${DATETIME.format(c.t)}`, was, c.unsure ? 'a store did not answer, so this may not be a real change' : ''].filter(Boolean).join(' · ') : 'not searched yet';
      return `<li><div class="part"><button type="button" class="wq" data-wq="${i}" title="Open this search">${esc(w.q)}</button><span class="price">${c ? formatTL(c.now) : '–'}</span>${move}<button type="button" class="rm" data-wrm="${i}" title="Stop watching" aria-label="${esc(`Stop watching ${w.q}`)}">✕</button></div><div class="meta">${esc(meta)}</div></li>`;
    })
    .join('');
}

/** Search every watched query again, one at a time, and say which got cheaper. */
async function checkWatched() {
  if (state.checking || !state.watch.length) return;
  state.checking = true;
  const btn = $('#checkWatch');
  btn.disabled = true;
  const cheaper = [];
  try {
    for (const [i, w] of [...state.watch].entries()) {
      btn.textContent = `Checking ${i + 1}/${state.watch.length}…`;
      const was = state.watchInfo.get(w.q)?.now;
      await runSearch(w.q, { fresh: true, sites: w.sites });
      const c = lastChange(await watchPoints(w));
      state.watchInfo.set(w.q, c);
      if (c && was != null && c.now < was) cheaper.push(`${w.q}: ${formatTL(was)} → ${formatTL(c.now)}`);
      renderWatch();
    }
    toast(cheaper.length ? `Cheaper now: ${cheaper.join(' · ')}` : 'Checked. None of your watched searches got cheaper.');
  } catch (e) {
    toast(e.message);
  } finally {
    state.checking = false;
    btn.disabled = false;
    btn.textContent = 'Check prices';
  }
}

/** On load: read every watched series (no store is opened) and point out drops since the last visit. */
async function loadWatch() {
  const seen = store.get('pcprice.watchSeen', 0);
  await Promise.all(state.watch.map(refreshWatchInfo));
  const drops = state.watch.filter((w) => {
    const c = state.watchInfo.get(w.q);
    return c?.before && c.diff < 0 && c.t > seen;
  });
  if (seen && drops.length) toast(`Cheaper since your last visit: ${drops.map((w) => `${w.q} ${formatTL(state.watchInfo.get(w.q).now)}`).join(' · ')}`);
  store.set('pcprice.watchSeen', Date.now());
}

/* ---------- chrome: recent searches, theme, keyboard ---------- */

function renderRecent() {
  $('#recent').innerHTML = state.recent.length
    ? `<span class="lbl">Recent</span>${state.recent.map((r) => `<button type="button" data-q="${esc(r)}">${esc(r)}</button>`).join('')}<button type="button" class="clear" data-clear title="Clear recent searches" aria-label="Clear recent searches">✕</button>`
    : '';
}

function applyTheme(mode, animate = false) {
  const root = document.documentElement;
  if (animate) replay(root, 'theme-anim', 360);
  if (mode === 'light' || mode === 'dark') root.dataset.theme = mode;
  else delete root.dataset.theme;
  const name = mode === 'light' ? 'Light' : mode === 'dark' ? 'Dark' : 'Auto';
  $('#theme').textContent = name;
  $('#theme').setAttribute('aria-label', `Theme: ${name}. Switch theme`);
}

function render() {
  renderStores();
  renderProgress();
  renderTable();
}

function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (typing) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.key === '/') {
    e.preventDefault();
    $('#q').focus();
    $('#q').select();
  } else if (e.target !== document.body) {
    return;
  } else if (e.key === 'j') select(state.sel + 1, { scroll: true });
  else if (e.key === 'k') select(Math.max(0, state.sel - 1), { scroll: true });
  else if (e.key === 'Enter' && state.list[state.sel]) window.open(state.list[state.sel].url, '_blank', 'noopener');
  else if (e.key === 'a' && state.list[state.sel]) addToBuild(state.list[state.sel]);
  else if (e.key === 'h' && state.list[state.sel]) showOfferHistory(state.list[state.sel]);
}

async function init() {
  const res = await fetch('/api/sites').then((r) => r.json());
  state.sites = res.sites;
  $('#unsupported').innerHTML = `<summary>${res.sites.length} stores searched · ${res.unsupported.length} can't be read</summary><ul>${res.unsupported.map((u) => `<li><b>${esc(u.name)}</b> ${esc(u.reason)}</li>`).join('')}</ul><p>Akakçe and Epey listings still include most of their offers.</p>`;

  $('#stores').onclick = (e) => {
    const chip = e.target.closest('.store');
    if (!chip) return;
    const id = chip.dataset.id;
    state.disabled.has(id) ? state.disabled.delete(id) : state.disabled.add(id);
    store.set('pcprice.disabled', [...state.disabled]);
    renderStores();
  };
  $('#search').onsubmit = (e) => {
    e.preventDefault();
    const q = $('#q').value.trim();
    if (q) search(q, $('#fresh').checked);
  };
  $('#recent').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if ('clear' in b.dataset) {
      state.recent = [];
      store.set('pcprice.recent', []);
      renderRecent();
    } else if (b.dataset.q) search(b.dataset.q, $('#fresh').checked);
  };
  $('#empty').onclick = (e) => {
    const b = e.target.closest('[data-ex]');
    if (b) search(b.dataset.ex, false);
  };
  for (const id of ['#showHidden', '#showAgg', '#onlyCash']) $(id).onchange = renderTable;
  for (const id of ['#refine', '#pmin', '#pmax']) $(id).oninput = renderTable;
  document.querySelectorAll('[data-sort]').forEach((b) => {
    b.onclick = () => {
      const key = b.dataset.sort;
      state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: 1 };
      renderTable();
    };
  });

  // The price ladder: hover for details, click to jump to the row.
  const track = $('#track');
  const tip = $('#tip');
  track.onmouseover = (e) => {
    const t = e.target.closest('.tick[data-i]');
    const o = t && state.list[Number(t.dataset.i)];
    if (!o) return (tip.hidden = true);
    tip.innerHTML = `<b>${formatTL(o.price)}</b> · ${esc(o.siteName)}<br>${esc(o.title.slice(0, 80))}`;
    tip.hidden = false;
    const box = $('#ladder').getBoundingClientRect();
    const r = t.getBoundingClientRect();
    const x = r.left + r.width / 2 - box.left;
    tip.style.left = `${Math.max(150, Math.min(box.width - 150, x))}px`;
  };
  track.onmouseleave = () => (tip.hidden = true);
  track.onclick = (e) => {
    const t = e.target.closest('.tick[data-i]');
    if (t) select(Number(t.dataset.i), { scroll: true });
  };
  $('#table tbody').onclick = (e) => {
    const hb = e.target.closest('[data-hist]');
    if (hb) return showOfferHistory(state.list[Number(hb.dataset.hist)]);
    const tr = e.target.closest('tr[data-i]');
    if (tr && !e.target.closest('a,button')) select(Number(tr.dataset.i));
  };

  $('#hMed').onchange = () => drawHistory(false);
  $('#hClose').onclick = () => {
    state.hist = state.histBase;
    renderHistory(true);
  };
  let histWidth = 0;
  new ResizeObserver(() => {
    const w = Math.round($('#hchart').clientWidth);
    if (w && w !== histWidth) {
      histWidth = w;
      if (state.hist) drawHistory(false);
    }
  }).observe($('#hchart'));

  $('#hWatch').onclick = toggleWatch;
  $('#checkWatch').onclick = checkWatched;
  $('#watchList').onclick = (e) => {
    const open = e.target.closest('[data-wq]');
    const rm = e.target.closest('[data-wrm]');
    if (open) search(state.watch[Number(open.dataset.wq)].q, false);
    if (rm) {
      const w = state.watch[Number(rm.dataset.wrm)];
      state.watch = state.watch.filter((x) => x !== w);
      state.watchInfo.delete(w.q);
      saveWatch();
    }
  };
  // A thumbnail the store's CDN refuses: drop it rather than show a broken image.
  $('#table tbody').addEventListener('error', (e) => e.target.matches?.('img.thumb') && e.target.replaceWith(Object.assign(document.createElement('span'), { className: 'thumb none' })), true);

  $('#recheck').onclick = recheckBuild;
  $('#copyBuild').onclick = copyBuild;
  const modes = ['auto', 'light', 'dark'];
  let mode = store.get('pcprice.theme', 'auto');
  applyTheme(mode);
  $('#theme').onclick = () => {
    mode = modes[(modes.indexOf(mode) + 1) % modes.length];
    store.set('pcprice.theme', mode);
    applyTheme(mode, true);
  };
  document.addEventListener('keydown', onKey);

  render();
  renderBuild();
  renderRecent();
  renderWatch();
  loadWatch();
  const q = new URLSearchParams(location.search).get('q');
  if (q) search(q, false);
}

init();
