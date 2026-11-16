// Pure helpers: Turkish price parsing, text normalisation and query matching.
// Nothing here touches the network or the browser, so it is unit-tested directly.

const TR_MAP = { ı: 'i', İ: 'i', ş: 's', Ş: 's', ğ: 'g', Ğ: 'g', ü: 'u', Ü: 'u', ö: 'o', Ö: 'o', ç: 'c', Ç: 'c' };

/** Lower-case, fold Turkish letters, drop soft hyphens, split letter/digit runs. */
export function normalize(text) {
  return String(text ?? '')
    .replace(/[­​-‍﻿]/g, '')
    .replace(/[ıİşŞğĞüÜöÖçÇ]/g, (c) => TR_MAP[c])
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokens(text) {
  const n = normalize(text);
  return n ? n.split(' ') : [];
}

/** Like tokens(), but remembers which token was written directly against the previous one ("7600X" → 7600, x[glued]). */
function glueTokens(text) {
  const folded = String(text ?? '')
    .replace(/[­​-‍﻿]/g, '')
    .replace(/[ıİşŞğĞüÜöÖçÇ]/g, (c) => TR_MAP[c])
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
  const out = [];
  for (const chunk of folded.split(/[^a-z0-9]+/).filter(Boolean)) {
    (chunk.match(/[a-z]+|\d+/g) ?? []).forEach((t, i) => out.push({ t, glued: i > 0 }));
  }
  return out;
}

/**
 * Parse a price as Turkish stores print it: "43.000 TL", "35.879,08 TL",
 * "₺1.234,5", "30.329,66TL". Numbers already typed as numbers pass through,
 * and machine strings like "30329.66" (JSON-LD) are read as decimals.
 * Percentages ("%10 indirim") and instalment plans ("12 x 375 TL", "9 Taksit")
 * are ignored. When a text holds several prices (old and new), the lowest one
 * marked as money (TL / ₺) wins. Returns null when no plausible price is present.
 */
export function parsePrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (value == null) return null;
  const compact = String(value).replace(/[\s\u00a0\u202f]/g, '');
  if (/^\d+(\.\d{1,2})?$/.test(compact)) {
    const n = Number(compact);
    return n > 0 ? n : null;
  }
  const text = String(value)
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/%\s*\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s*%/g, ' ')
    .replace(/\d+\s*[x×]\s*(?:₺\s*)?[\d.,]+\s*(?:tl|₺)?/gi, ' ')
    .replace(/\d+\s*(?:aya varan\s*)?taksit\w*/gi, ' ');
  const re = /(₺\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)(\s*(?:tl|₺))?/gi;
  const marked = [];
  let firstPlain = null;
  for (const m of text.matchAll(re)) {
    const n = Number(m[2].replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) continue;
    if (m[1] || m[3]) marked.push(n);
    else firstPlain ??= n;
  }
  return marked.length ? Math.min(...marked) : firstPlain;
}

/**
 * Split a search box query into what must and must not appear in a title.
 * "rtx 4060 -ti -laptop" → include [rtx, 4060], exclude [ti, laptop].
 */
export function parseQuery(query) {
  const include = [];
  const exclude = [];
  const words = [];
  for (const raw of String(query ?? '').split(/\s+/).filter(Boolean)) {
    if (raw.startsWith('-') && raw.length > 1) {
      exclude.push(...tokens(raw.slice(1)));
    } else {
      const t = tokens(raw);
      include.push(...t);
      if (t.length) words.push(t);
    }
  }
  return { include, exclude, words, text: include.join(' ') };
}

// A suffix glued onto a number makes another model (7600X, 12400F) unless it is a unit or "Ti".
const UNIT_SUFFIX = new Set(['gb', 'tb', 'mb', 'kb', 'mhz', 'ghz', 'hz', 'w', 'mm', 'cm', 'v', 'a', 'ti']);

function hasRun(toks, word) {
  const n = word.length;
  outer: for (let i = 0; i + n <= toks.length; i++) {
    for (let k = 0; k < n; k++) if (toks[i + k].t !== word[k]) continue outer;
    const next = toks[i + n];
    if (next?.glued && /^\d+$/.test(word[n - 1]) && /^[a-z]+$/.test(next.t) && !UNIT_SUFFIX.has(next.t)) continue;
    return true;
  }
  return false;
}

/**
 * True when every query word is in the title with its letters and digits together
 * and in order ("32gb ddr5" does not match "32GB DDR4 … 5"), none of them is a
 * longer model name ("7600" ≠ "7600X"), and no excluded word appears.
 */
export function matches(title, parsed) {
  const toks = glueTokens(title);
  const have = new Set(toks.map((x) => x.t));
  if (parsed.exclude.some((t) => have.has(t))) return false;
  const words = parsed.words ?? parsed.include.map((t) => [t]);
  return words.every((w) => hasRun(toks, w));
}

// Phrases that mark a title as an accessory for the part rather than the part
// ("RTX 4060 ile uyumlu ekran koruyucu"). Ignored when the query uses them.
// A power supply lists its cables; a motherboard lists the CPU, RAM and SSD it takes.
const CABLE_OK = ['guc kaynagi', 'psu', 'moduler'];
const NOT_A_SYSTEM = ['anakart', 'guc kaynagi'];
const ACCESSORY = [
  'ile uyumlu',
  'ekran koruyucu',
  'koruyucu',
  'notebook adaptor',
  'laptop adaptor',
  'dizustu adaptor',
  'sarj',
  'kilif',
  'sticker',
  'etiket',
  'klavye',
  'kablo',
  'braket',
  'yedek parca',
  'muadil',
];
const SYSTEM = ['notebook', 'laptop', 'dizustu', 'hazir sistem', 'sistem tavsiyesi', 'oyun bilgisayari', 'masaustu bilgisayar', 'all in one', 'mini pc'];
const COMPONENT_SIGNS = [
  /\b(ryzen|core|intel|i [3579])\b/,
  /\b(rtx|gtx|radeon|rx|arc)\b/,
  /\b(ddr [345]|ram)\b/,
  /\b(ssd|hdd|nvme)\b/,
];

const hasPhrase = (norm, phrase) => ` ${norm} `.includes(` ${phrase} `);

/**
 * Why a matching title is probably not the bare PC part the user wants:
 * 'accessory' (screen protector, adapter, "compatible with"), 'system'
 * (laptop or prebuilt PC: names a CPU, GPU, RAM and storage together), or null.
 */
export function classify(title, parsed) {
  const norm = normalize(title);
  const q = ` ${parsed.include.join(' ')} `;
  const unasked = (p) => !q.includes(` ${p} `);
  const cableOk = CABLE_OK.some((p) => hasPhrase(norm, p));
  if (ACCESSORY.some((p) => unasked(p) && hasPhrase(norm, p) && !(p === 'kablo' && cableOk))) return 'accessory';
  if (SYSTEM.some((p) => unasked(p) && hasPhrase(norm, p))) return 'system';
  const signs = COMPONENT_SIGNS.filter((re) => re.test(norm)).length;
  const querySigns = COMPONENT_SIGNS.filter((re) => re.test(parsed.include.join(' '))).length;
  if (signs >= 3 && querySigns < 3 && !NOT_A_SYSTEM.some((p) => hasPhrase(norm, p))) return 'system';
  return null;
}

/**
 * Mark offers priced far below the typical match as outliers: a price under a
 * quarter of the lower quartile is almost always an accessory the phrase list
 * missed. Needs `minOffers` unflagged offers to judge, and a wide but continuous
 * spread (a broad query like "ssd") is left alone.
 */
export function flagOutliers(offers, ratio = 0.25, minOffers = 4) {
  const prices = offers.filter((o) => !o.flag).map((o) => o.price).sort((a, b) => a - b);
  if (prices.length < minOffers) return offers;
  const ref = prices[Math.floor((prices.length - 1) / 4)];
  return offers.map((o) => (!o.flag && o.price < ref * ratio ? { ...o, flag: 'outlier' } : o));
}

/** Keep only http(s) links, and drop tracking noise where the product id is enough. */
export function cleanUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // Sponsored results wrap the product path in /sspa/click?url=...
    const asin = u.hostname.endsWith('amazon.com.tr') && decodeURIComponent(u.pathname + u.search).match(/\/dp\/([A-Z0-9]{10})/);
    if (asin) return `https://www.amazon.com.tr/dp/${asin[1]}`;
    return url;
  } catch {
    return null;
  }
}

/** Strip ad labels stores prepend to titles ("Sponsorlu Reklam - ..."). */
export function cleanTitle(title) {
  return String(title).replace(/^\s*sponsorlu(\s+reklam)?\s*[-–:|]?\s*/i, '').trim();
}

/**
 * Read an instalment badge off a product card's text. `cashPrice` is true only
 * when the store says instalments cost no more than paying at once: "Peşin
 * fiyatına 9 taksit", "Vade farksız", "Faizsiz". A bare "9 Taksit" is reported
 * with cashPrice false, because it says nothing about interest.
 * Returns { months, cashPrice } (months = the longest plan, or null), or null.
 */
export function parseInstallment(text) {
  const n = normalize(text);
  if (!n.includes('taksit')) return null;
  const cashPrice = /\bpesin fiyat\w* (?:\d+ )?taksit|\bvade farksiz|\bfaizsiz/.test(n);
  let months = null;
  for (const m of n.matchAll(/(\d{1,2}) (?:aya varan )?taksit/g)) months = Math.max(months ?? 0, Number(m[1]));
  return { months, cashPrice };
}

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function formatTL(n) {
  return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 2 }).format(n);
}
