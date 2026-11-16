#!/usr/bin/env node
// Terminal search: node src/cli.js "rtx 4060 -ti" [--sites=akakce,trendyol] [--top=20] [--all] [--json]
import { searchAll } from './search.js';
import { closeBrowser } from './browser.js';
import { formatTL } from './text.js';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const query = args.filter((a) => !a.startsWith('--')).join(' ');
if (!query) {
  console.error('Usage: node src/cli.js "<query> [-exclude ...]" [--sites=a,b] [--top=N] [--all] [--json]');
  process.exit(1);
}
const top = Number(flag('top') ?? 20);
const json = args.includes('--json');
const showAll = args.includes('--all');

try {
  const result = await searchAll(query, {
    siteIds: flag('sites')?.split(','),
    onSite: (r) => {
      if (json) return;
      const note = r.status === 'ok' ? `${r.offers.length} match / ${r.found} found` : `${r.status}${r.error ? `: ${r.error}` : ''}`;
      console.error(`  ${r.siteName.padEnd(17)} ${note}  (${(r.ms / 1000).toFixed(1)}s)`);
    },
  });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const shown = showAll ? result.offers : result.offers.filter((o) => !o.flag);
    const hidden = result.offers.length - shown.length;
    const note = hidden ? ` (${hidden} accessories/systems/outliers hidden; --all shows them)` : '';
    console.log(`\nCheapest ${Math.min(top, shown.length)} of ${shown.length} offers for "${query}"${note}:\n`);
    for (const o of shown.slice(0, top)) {
      const tag = o.flag ? ` [${o.flag}]` : o.kind === 'aggregator' && o.offers ? ` [${o.offers}]` : '';
      console.log(`${formatTL(o.price).padStart(14)}  ${o.siteName.padEnd(17)} ${o.title.slice(0, 80)}${tag}`);
      console.log(`${''.padStart(14)}  ${o.url}`);
    }
  }
} finally {
  await closeBrowser();
}
