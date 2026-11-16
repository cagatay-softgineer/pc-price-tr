import { flagOutliers, formatTL } from '/lib/text.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const FLAG_LABEL = { accessory: 'accessory', system: 'laptop / prebuilt', outlier: 'suspiciously cheap' };

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
  source: null,
};

/** Run one search over SSE; resolves with the final offer list. */
function runSearch(q, { fresh = false, onSite } = {}) {
  const sites = state.sites.filter((s) => !state.disabled.has(s.id)).map((s) => s.id);
  const url = `/api/search?q=${encodeURIComponent(q)}&sites=${sites.join(',')}${fresh ? '&fresh=1' : ''}`;
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

async function search(q, fresh) {
  state.query = q;
  state.offers = [];
  state.status = {};
  for (const s of state.sites) if (!state.disabled.has(s.id)) state.status[s.id] = { state: 'loading', text: '' };
  $('#search button').disabled = true;
  render();
  const partial = [];
  try {
    state.offers = await runSearch(q, {
      fresh,
      onSite: (r) => {
        const text = r.status === 'ok' ? String(r.offers.length) : r.status;
        state.status[r.site] = { state: r.status, text, title: r.error || `${r.found} found, ${r.offers.length} matched · ${(r.ms / 1000).toFixed(1)}s${r.cached ? ' (cached)' : ''}` };
        partial.push(...r.offers);
        state.offers = flagOutliers(partial).sort((a, b) => a.price - b.price);
        render();
      },
    });
  } catch (e) {
    $('#summary').textContent = e.message;
  } finally {
    $('#search button').disabled = false;
    render();
  }
}

function visibleOffers() {
  const showHidden = $('#showHidden').checked;
  const showAgg = $('#showAgg').checked;
  const onlyCash = $('#onlyCash').checked;
  return state.offers.filter(
    (o) => (showHidden || !o.flag) && (showAgg || o.kind !== 'aggregator') && (!onlyCash || o.installment?.cashPrice),
  );
}

/** "Peşin fiyatına 9 taksit" when the store promises the cash price, else a plain "9 taksit". */
function installmentLabel(inst) {
  if (!inst) return '';
  const n = inst.months ? `${inst.months} taksit` : 'taksit';
  return inst.cashPrice ? `Peşin fiyatına ${n}` : n;
}

function renderStores() {
  $('#stores').innerHTML = state.sites
    .map((s) => {
      const st = state.status[s.id];
      const off = state.disabled.has(s.id);
      const cls = ['store', off ? 'off' : '', st?.state ?? ''].join(' ');
      return `<span class="${cls}" data-id="${s.id}" title="${esc(off ? 'Click to include' : st?.title ?? 'Click to skip this store')}">${esc(s.name)} <span class="n">${esc(st?.text ?? '')}</span></span>`;
    })
    .join('');
}

function renderBest(list) {
  const best = new Map();
  for (const o of list) if (o.kind === 'store' && !best.has(o.site)) best.set(o.site, o);
  const cards = [...best.values()].sort((a, b) => a.price - b.price);
  $('#best').innerHTML = cards
    .map(
      (o, i) =>
        `<a class="card${i === 0 ? ' top' : ''}" href="${esc(o.url)}" target="_blank" rel="noopener"><span>${esc(o.siteName)}</span><b>${formatTL(o.price)}</b></a>`,
    )
    .join('');
}

function renderTable() {
  const list = visibleOffers();
  const tbody = $('#table tbody');
  const cheapest = list.find((o) => !o.flag)?.price;
  tbody.innerHTML = list
    .map((o, i) => {
      const badges = [
        o.kind === 'aggregator' && o.offers ? `<span class="badge">${esc(o.offers)}</span>` : '',
        o.installment ? `<span class="badge${o.installment.cashPrice ? ' cash' : ''}">${esc(installmentLabel(o.installment))}</span>` : '',
        o.flag ? `<span class="badge flag">${FLAG_LABEL[o.flag]}</span>` : '',
      ].join('');
      const cls = [o.price === cheapest && !o.flag ? 'cheapest' : '', o.flag ? 'hidden-row' : ''].join(' ');
      return `<tr class="${cls}">
        <td class="num">${formatTL(o.price)}</td>
        <td class="store-cell">${esc(o.siteName)}</td>
        <td class="title"><a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.title)}</a>${badges}</td>
        <td class="act"><button class="ghost" data-add="${i}" title="Add to my build">+</button></td>
      </tr>`;
    })
    .join('');
  tbody.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => addToBuild(list[Number(b.dataset.add)])));
  const loading = Object.values(state.status).some((s) => s.state === 'loading');
  $('#empty').style.display = list.length ? 'none' : 'block';
  $('#empty').textContent = loading ? 'Searching stores…' : state.query ? 'No matching offers. Try fewer words.' : 'Search for a part to compare prices.';
  const hidden = state.offers.filter((o) => o.flag).length;
  $('#summary').textContent = state.query
    ? `${list.length} offers for “${state.query}”${hidden && !$('#showHidden').checked ? ` · ${hidden} hidden (accessories, laptops/prebuilts, outliers)` : ''}${loading ? ' · still searching…' : ''}`
    : '';
  renderBest(list);
}

function addToBuild(o) {
  state.build.push({
    id: crypto.randomUUID(),
    part: state.query,
    query: state.query,
    offer: { title: o.title, price: o.price, url: o.url, siteName: o.siteName },
    checkedAt: Date.now(),
  });
  saveBuild();
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
          (b) => `<li data-id="${b.id}">
      <div class="part"><input value="${esc(b.part)}" aria-label="Part name" /><span class="price">${formatTL(b.offer.price)}</span><button class="rm" title="Remove">✕</button></div>
      <div class="meta"><a href="${esc(b.offer.url)}" target="_blank" rel="noopener">${esc(b.offer.siteName)} · ${esc(b.offer.title.slice(0, 70))}</a></div>
      <div class="meta">checked ${new Date(b.checkedAt).toLocaleString('tr-TR')}${b.gone ? ' · <b>no longer listed</b>' : ''}</div>
      ${b.alt ? `<div class="alt">Cheaper now: <a href="${esc(b.alt.url)}" target="_blank" rel="noopener">${formatTL(b.alt.price)} at ${esc(b.alt.siteName)}</a></div>` : ''}
    </li>`,
        )
        .join('')
    : '<li class="meta">Nothing yet.</li>';
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
  $('#buildTotal').textContent = formatTL(state.build.reduce((sum, b) => sum + b.offer.price, 0));
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
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Re-check prices';
  }
}

function render() {
  renderStores();
  renderTable();
}

async function init() {
  const res = await fetch('/api/sites').then((r) => r.json());
  state.sites = res.sites;
  $('#unsupported').textContent = `Not searched: ${res.unsupported.map((u) => `${u.name} (${u.reason})`).join('; ')}. Akakçe and Epey listings still include most of their offers.`;
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
  $('#showHidden').onchange = renderTable;
  $('#showAgg').onchange = renderTable;
  $('#onlyCash').onchange = renderTable;
  $('#recheck').onclick = recheckBuild;
  render();
  renderBuild();
  const q = new URLSearchParams(location.search).get('q');
  if (q) {
    $('#q').value = q;
    search(q, false);
  }
}

init();
