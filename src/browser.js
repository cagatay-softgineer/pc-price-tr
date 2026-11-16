// One shared, persistent Chrome session for all scraping.
//
// Why real Chrome, headful: most Turkish stores sit behind Cloudflare, which
// blocks plain HTTP clients and flags headless Chrome. A normal Chrome window
// with a persistent profile passes the JS challenge once and keeps the
// clearance cookie. The window is parked off-screen so it stays out of the way.
// Set PCPRICE_HEADLESS=1 to try headless anyway, PCPRICE_SHOW=1 to see it.
// Interactive checks ("verify you are human") are never clicked by code: the
// user passes them once via `npm run unlock` and the profile keeps the cookie.
import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapLimit } from './pool.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = process.env.PCPRICE_PROFILE || path.join(ROOT, '.browser-profile');
// Interstitial titles: Cloudflare (EN/TR) and Hepsiburada's own bot wall.
const CHALLENGE = /^(just a moment|bir dakika|attention required)|\|\s*güvenlik\s*$/i;
const BLOCKED_TYPES = new Set(['image', 'media', 'font']);

let ctxPromise = null;

async function launch() {
  const headless = process.env.PCPRICE_HEADLESS === '1';
  const show = process.env.PCPRICE_SHOW === '1';
  const opts = {
    headless,
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    viewport: { width: 1366, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      // An off-screen window must not be throttled like a background tab.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      ...(show || headless ? [] : ['--window-position=-32000,-32000']),
    ],
  };
  let lastError;
  for (const channel of ['chrome', 'msedge']) {
    try {
      const ctx = await chromium.launchPersistentContext(PROFILE, { ...opts, channel });
      await ctx.route('**/*', (route) =>
        BLOCKED_TYPES.has(route.request().resourceType()) ? route.abort() : route.continue(),
      );
      ctx.on('close', () => {
        ctxPromise = null;
      });
      return ctx;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(
    `Could not start Chrome or Edge (${lastError?.message?.split('\n')[0]}). ` +
      'Is another pc-price-tr process using the browser profile? Set PCPRICE_PROFILE to a different folder.',
  );
}

export function getContext() {
  ctxPromise ??= launch().catch((e) => {
    ctxPromise = null;
    throw e;
  });
  return ctxPromise;
}

export async function closeBrowser() {
  if (!ctxPromise) return;
  const ctx = await ctxPromise.catch(() => null);
  ctxPromise = null;
  await ctx?.close().catch(() => {});
}

/** Poll the title until a challenge interstitial clears (polls × 1.5s); returns the final title. */
async function waitOutChallenge(page, polls = 15) {
  let title = await page.title().catch(() => '');
  for (let i = 0; i < polls && CHALLENGE.test(title); i++) {
    await page.waitForTimeout(1500);
    title = await page.title().catch(() => '');
  }
  return title;
}

/**
 * Open a store's search page, wait out any challenge and for the results to
 * render, then run the site's in-page extractor. With `pages` > 1 and a store
 * that has a `page(query, n)` URL, the next result pages are read too.
 * Aborting `signal` closes the tab. Returns
 * { status: 'ok' | 'blocked' | 'error' | 'cancelled', items, title, ms, error? }.
 */
export async function scrape(site, query, { timeoutMs = 45000, keep = () => true, pages = 1, signal } = {}) {
  const started = Date.now();
  const cancelled = () => ({ status: 'cancelled', items: [], ms: Date.now() - started });
  if (signal?.aborted) return cancelled();
  const ctx = await getContext();
  const page = await ctx.newPage();
  const onAbort = () => page.close().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await page.goto(site.url(query), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const title = await waitOutChallenge(page);
    if (CHALLENGE.test(title)) {
      // An interactive check we must not click for the user: see src/unlock.js.
      return { status: 'blocked', items: [], title, error: 'Needs a manual check: run `npm run unlock`', ms: Date.now() - started };
    }
    const items = await readResults(page, site);
    for (let n = 2; n <= pages && site.page && items.length; n++) {
      // A later page that fails or is empty only means fewer results, never a failed store.
      try {
        await page.goto(site.page(query, n), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        if (CHALLENGE.test(await waitOutChallenge(page, 6))) break;
        const more = await readResults(page, site);
        if (!more.length) break;
        items.push(...more);
      } catch {
        break;
      }
    }
    if (signal?.aborted) return cancelled();
    const blocked = site.details ? await priceFromDetailPages(ctx, site, items, keep) : 0;
    if (blocked) {
      return {
        status: 'blocked',
        items,
        title,
        error: `${blocked} product page(s) need a manual check: run \`npm run unlock\``,
        ms: Date.now() - started,
      };
    }
    return { status: 'ok', items, title, ms: Date.now() - started };
  } catch (e) {
    if (signal?.aborted) return cancelled();
    return { status: 'error', items: [], error: e.message.split('\n')[0], ms: Date.now() - started };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await page.close().catch(() => {});
  }
}

/** Wait for a result page to render, run the store's extractor, and read its script-only badges. */
async function readResults(page, site) {
  // No match within the wait usually means "no results"; extract anyway.
  await page.waitForSelector(site.waitFor, { state: 'attached', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  const items = await page.evaluate(site.extract, site.cfg ?? null);
  if (site.scriptBadges && items.length) {
    const badges = await page.evaluate(site.scriptBadges, items.map((i) => i.url));
    items.forEach((item, i) => (item.installmentText = [item.text, badges[i]].filter(Boolean).join(' ')));
  }
  return items;
}

/** Fill in prices for unpriced items the caller wants, from their own pages, 3 at a time. */
async function priceFromDetailPages(ctx, site, items, keep) {
  const todo = items.filter((i) => i.price == null && i.url && keep(i.title)).slice(0, site.details.limit);
  let blocked = 0;
  await mapLimit(todo, 3, async (item) => {
    const page = await ctx.newPage();
    try {
      await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (CHALLENGE.test(await waitOutChallenge(page, 6))) {
        blocked++;
        return;
      }
      await page.waitForLoadState('domcontentloaded');
      const { price } = await page.evaluate(site.details.extract);
      item.price = price;
    } catch {
      /* leave unpriced: the offer is dropped */
    } finally {
      await page.close().catch(() => {});
    }
  });
  return blocked;
}
