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

/**
 * Parse a price as Turkish stores print it: "43.000 TL", "35.879,08 TL",
 * "₺1.234,5", "30.329,66TL". Numbers already typed as numbers pass through,
 * and machine strings like "30329.66" (JSON-LD) are read as decimals.
 * Returns null when no plausible price is present.
 */
export function parsePrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (value == null) return null;
  const s = String(value).replace(/[\s  ]/g, '');
  if (/^\d+(\.\d{1,2})?$/.test(s)) {
    const n = Number(s);
    return n > 0 ? n : null;
  }
  const m = s.match(/\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?/);
  if (!m) return null;
  const n = Number(m[0].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Split a search box query into what must and must not appear in a title.
 * "rtx 4060 -ti -laptop" → include [rtx, 4060], exclude [ti, laptop].
 */
export function parseQuery(query) {
  const include = [];
  const exclude = [];
  for (const raw of String(query ?? '').split(/\s+/).filter(Boolean)) {
    if (raw.startsWith('-') && raw.length > 1) exclude.push(...tokens(raw.slice(1)));
    else include.push(...tokens(raw));
  }
  return { include, exclude, text: include.join(' ') };
}

/** True when every include token is a whole word of the title and no exclude token is. */
export function matches(title, parsed) {
  const words = new Set(tokens(title));
  return parsed.include.every((t) => words.has(t)) && !parsed.exclude.some((t) => words.has(t));
}

// Phrases that mark a title as an accessory for the part rather than the part
// ("RTX 4060 ile uyumlu ekran koruyucu"). Ignored when the query uses them.
const ACCESSORY = [
  'uyumlu',
  'ekran koruyucu',
  'koruyucu',
  'adaptor',
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
  if (ACCESSORY.some((p) => unasked(p) && hasPhrase(norm, p))) return 'accessory';
  if (SYSTEM.some((p) => unasked(p) && hasPhrase(norm, p))) return 'system';
  const signs = COMPONENT_SIGNS.filter((re) => re.test(norm)).length;
  const querySigns = COMPONENT_SIGNS.filter((re) => re.test(parsed.include.join(' '))).length;
  if (signs >= 3 && querySigns < 3) return 'system';
  return null;
}

/**
 * Mark offers priced far below the typical match as outliers: with a part
 * query, a price under a quarter of the median is almost always an accessory
 * the phrase list missed. Only unflagged offers count toward the median.
 */
export function flagOutliers(offers, ratio = 0.25) {
  const m = median(offers.filter((o) => !o.flag).map((o) => o.price));
  if (!m) return offers;
  return offers.map((o) => (!o.flag && o.price < m * ratio ? { ...o, flag: 'outlier' } : o));
}

/** Drop tracking noise from store URLs where the product id is enough. */
export function cleanUrl(url) {
  try {
    const u = new URL(url);
    // Sponsored results wrap the product path in /sspa/click?url=...
    const asin = u.hostname.endsWith('amazon.com.tr') && decodeURIComponent(u.pathname + u.search).match(/\/dp\/([A-Z0-9]{10})/);
    if (asin) return `https://www.amazon.com.tr/dp/${asin[1]}`;
    return url;
  } catch {
    return url;
  }
}

/** Strip ad labels stores prepend to titles ("Sponsorlu Reklam - ..."). */
export function cleanTitle(title) {
  return String(title).replace(/^\s*sponsorlu(\s+reklam)?\s*[-–:|]?\s*/i, '').trim();
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
