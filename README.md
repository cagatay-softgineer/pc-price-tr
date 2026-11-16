# PC Price TR

Finds the cheapest offer for a PC part across Turkish stores. Searches Akakçe, Epey, Trendyol, Hepsiburada, n11, Amazon TR, İtopya, İncehesap, Vatan Bilgisayar, MediaMarkt and Sinerji in parallel, then sorts every matching offer by price.

## Why scraping, not an API

There is no all-in-one price API for Turkish stores (checked 2026-10-10):

- **Akakçe, Cimri, Epey**: their only integrations are seller-side product feeds, used by stores to push prices *in*. None offers a public query API.
- **Trendyol, Hepsiburada**: they expose seller/partner APIs for managing your own listings, not a search API for other sellers' prices.
- The only "APIs" are paid third-party scrapers (Apify actors, Anysite and similar), which are scrapers too, billed per request.

So this app reads the stores' own search pages. Plain HTTP doesn't work: most stores sit behind Cloudflare, which blocks non-browser clients and flags headless Chrome. The app drives your installed **Chrome** (Edge as a fallback) through `playwright-core`. It uses a persistent profile in `.browser-profile/`, so a passed challenge is remembered, and the window is parked off-screen.

## Use it

Requires Node 20+ and Google Chrome or Microsoft Edge. No browser download is needed.

```bash
npm install
npm start                      # web app at http://127.0.0.1:4870
npm run search -- "rtx 4060 -ti"            # terminal, cheapest 20
npm run search -- "ryzen 7 7800x3d" --top=10 --sites=akakce,trendyol --all --json
npm run unlock                 # pass a store's "verify you are human" check by hand
npm test                       # unit tests for parsing/matching/flagging
```

**Query rules.** Every word must appear in the product title as a whole word, so `4060` does not match `40600`. Letters and digits are split, so `rtx4060ti` = `rtx 4060 ti`. Turkish letters fold (`ı`→`i`). A word prefixed with `-` excludes titles that contain it: `rtx 4060 -ti -laptop`.

**Hidden offers.** Matching offers that aren't the bare part are hidden by default. They still show as a count, and the "show hidden" toggle (or `--all`) reveals them:

- `accessory`: "uyumlu", screen protectors, adapters, cables and similar
- `laptop / prebuilt`: laptop/notebook/hazır sistem, or a title naming a CPU, GPU, RAM and storage together
- `suspiciously cheap`: under 25% of the median of the other matches

A word you searched for is never treated as noise. `klavye` finds keyboards, for example.

**My build** (web app). Use **+** on any result to add it to a parts list with a running total, saved in your browser. **Re-check prices** re-runs each part's search, updates the saved listing's price, and points out a cheaper store offer if one appeared.

Results are cached for 10 minutes per store and query. Tick **fresh** (or use **Re-check**) to bypass the cache.

## Stores

| Store | How it's read | Notes |
|---|---|---|
| Akakçe | Astro island props embedded in the search page | Aggregator: one row per product (its lowest price) with a seller count |
| Epey | Results grid, or the category table a query redirects to | Aggregator |
| Trendyol | Product cards | |
| Hepsiburada | Product cards (hashed CSS-module classes, matched by prefix) | |
| n11, MediaMarkt | schema.org JSON-LD | |
| Amazon TR | Search result cards | Sponsored links normalised to `/dp/<ASIN>` |
| İtopya | Product cards | Out-of-stock items have no price and are skipped |
| İncehesap | `/ajax/search.php` (search box suggestions, up to ~5), then each matching product page for the price | Its search URL redirects to keyword landing pages, often the wrong one |
| Vatan Bilgisayar, Sinerji | Product cards | |
| ~~Cimri, Teknosa~~ | — | Cloudflare blocks automated Chrome outright |
| ~~Gaming.gen.tr~~ | — | Search redirects to a single product page |

## When a store says "blocked"

Sometimes Cloudflare shows an interactive "Gerçek kişi olduğunuzu doğrulayın" checkbox instead of the automatic check. İncehesap's product pages did this during development. The app never clicks these checks for you. The store's status chip shows `blocked`, and its offers are missing from that search. Run `npm run unlock` (optionally with store ids, e.g. `npm run unlock -- incehesap`). It opens the app's own profile in a visible Chrome window. Tick the box, close the window, and later searches reuse the clearance.

Only one process can use `.browser-profile/` at a time. Stop the server before running the CLI or `unlock`, or set `PCPRICE_PROFILE` to another folder. Other switches: `PCPRICE_SHOW=1` shows the browser window, `PCPRICE_HEADLESS=1` runs headless (most stores will block it), and `PORT`/`HOST` set the web server address.

## Layout

```
src/text.js      pure helpers: price parsing, normalisation, matching, flagging (shared with the UI)
src/sites.js     store registry + in-page extractors
src/browser.js   shared persistent Chrome session, challenge handling, detail-page pricing
src/search.js    fan-out, cache, offer normalisation
src/server.js    local HTTP server + SSE search stream
src/cli.js       terminal search
src/unlock.js    open the profile visibly to pass checks by hand
public/          web UI (no build step)
scripts/         dev tools: probe.mjs (save live pages to .probe/), try-extract.mjs (run extractors
                 on saved pages offline), find-search-url.mjs, inspect.py / card.py (markup skeletons)
```

### Adding or fixing a store

1. `node scripts/probe.mjs "<query>" --headful <id>` saves the rendered page to `.probe/<id>.html`. Add the URL to the probe's list first.
2. Look at the cards with `python -I scripts/card.py .probe/<id>.html '<tag regex>'`.
3. Add an entry to `SITES` in `src/sites.js`. Use `extractCards` with selectors, `extractJsonLd`, or a custom in-page function. Extractors run inside the page, so they can't use module scope.
4. `npm run check:extractors -- <id>` runs it offline against the saved page. Then check it live with `npm run search -- "<query>" --sites=<id>`.

Stores change their markup without notice. When a store suddenly shows `0` found, re-probe it and adjust its selectors.

## Be a good citizen

This is for personal price checking. It opens one search page per store per query, caches results, and doesn't crawl. Each store's terms of use apply to automated access, so keep the volume low and don't run it as a public service.
