#!/usr/bin/env node
// Terminal search: node src/cli.js "rtx 4060 -ti" [--sites=akakce,trendyol] [--top=20] [--all] [--taksit] [--deep] [--json]
// Searches are added to the same price history as the web app's (.cache/history.json).
import { scopeOf, searchAll } from './search.js';
import { closeBrowser } from './browser.js';
import { createHistory, HISTORY_FILE } from './history.js';
import { formatTL } from './text.js';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const query = args.filter((a) => !a.startsWith('--')).join(' ');
if (!query) {
  console.error('Usage: node src/cli.js "<query> [-exclude ...]" [--sites=a,b] [--top=N] [--all] [--taksit] [--deep] [--json]');
  process.exit(1);
}
const top = Number(flag('top') ?? 20);
const json = args.includes('--json');
const showAll = args.includes('--all');
const onlyCash = args.includes('--taksit'); // only "Peşin fiyatına taksit" offers
const siteIds = flag('sites')?.split(',');
const history = createHistory({ file: HISTORY_FILE });
const DATE = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' });

try {
  const result = await searchAll(query, {
    siteIds,
    deep: args.includes('--deep'),
    onSite: (r) => {
      if (json) return;
      const note = r.status === 'ok' ? `${r.offers.length} match / ${r.found} found` : `${r.status}${r.error ? `: ${r.error}` : ''}`;
      console.error(`  ${r.siteName.padEnd(17)} ${note}  (${(r.ms / 1000).toFixed(1)}s)`);
    },
  });
  for (const o of result.offers) {
    const prev = history.priceBefore(o.url, o.price);
    if (prev) o.prev = prev;
  }
  history.record(query, result.offers, { scope: scopeOf(siteIds), results: result.results, queryPoint: !args.includes('--deep') });
  await history.save().catch((e) => console.error('history:', e.message));
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const base = showAll ? result.offers : result.offers.filter((o) => !o.flag);
    const shown = onlyCash ? base.filter((o) => o.installment?.cashPrice) : base;
    const hidden = result.offers.length - shown.length;
    const note = hidden ? ` (${hidden} accessories/systems/outliers hidden; --all shows them)` : '';
    console.log(`\nCheapest ${Math.min(top, shown.length)} of ${shown.length} offers for "${query}"${note}:\n`);
    for (const o of shown.slice(0, top)) {
      const cash = o.installment?.cashPrice ? ` [peşin fiyatına ${o.installment.months ? `${o.installment.months} taksit` : 'taksit'}]` : '';
      const tag = (o.flag ? ` [${o.flag}]` : o.kind === 'aggregator' && o.offers ? ` [${o.offers}]` : '') + cash;
      const moved = o.prev ? `  (${o.price < o.prev.price ? '↓' : '↑'} was ${formatTL(o.prev.price)} on ${DATE.format(o.prev.t)})` : '';
      console.log(`${formatTL(o.price).padStart(14)}  ${o.siteName.padEnd(17)} ${o.title.slice(0, 80)}${tag}${moved}`);
      console.log(`${''.padStart(14)}  ${o.url}`);
    }
  }
} finally {
  await closeBrowser();
}
