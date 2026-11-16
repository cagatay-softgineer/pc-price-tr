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
 * render, then run the site's in-page extractor.
 * Returns { status: 'ok' | 'blocked' | 'error', items, title, ms, error? }.
 */
export async function scrape(site, query, { timeoutMs = 45000, keep = () => true } = {}) {
  const started = Date.now();
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto(site.url(query), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const title = await waitOutChallenge(page);
    if (CHALLENGE.test(title)) {
      // An interactive check we must not click for the user: see src/unlock.js.
      return { status: 'blocked', items: [], title, error: 'Needs a manual check: run `npm run unlock`', ms: Date.now() - started };
    }
    // No match within the wait usually means "no results"; extract anyway.
    await page.waitForSelector(site.waitFor, { state: 'attached', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    const items = await page.evaluate(site.extract, site.cfg ?? null);
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
    return { status: 'error', items: [], error: e.message.split('\n')[0], ms: Date.now() - started };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Fill in prices for unpriced items the caller wants, from their own pages. */
async function priceFromDetailPages(ctx, site, items, keep) {
  const todo = items.filter((i) => i.price == null && i.url && keep(i.title)).slice(0, site.details.limit);
  let blocked = 0;
  await Promise.all(
    todo.map(async (item) => {
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
    }),
  );
  return blocked;
}
