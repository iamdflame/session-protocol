// Merge raw history with curated tags into the single snapshot the app loads.
import { readFileSync, writeFileSync } from 'node:fs';
const { META } = await import('../src/meta.js');

const hist = JSON.parse(readFileSync('data/_history.json', 'utf8'));
const assets = hist
  .filter(a => META[a.symbol])
  .map(a => ({
    symbol: a.symbol, mint: a.mint, kind: a.kind,
    co: META[a.symbol].co, tags: META[a.symbol].tags,
    price: a.price, jupPrice: a.jupPrice, liquidity: a.liquidity,
    holders: a.holders, decimals: a.decimals,
    pool: a.pool, days: a.days,
    rows: a.rows.map(r => [r.t, +r.c.toFixed(6)]),
  }));

const unknown = hist.filter(a => !META[a.symbol]).map(a => a.symbol);
if (unknown.length) console.error('[build] no metadata, dropped:', unknown.join(', '));

writeFileSync('data/universe.json', JSON.stringify({
  generated: new Date().toISOString(),
  source: 'Jupiter (spot/liquidity) + GeckoTerminal (daily OHLCV from Solana pools)',
  assets,
}));
console.error(`[build] ${assets.length} assets  (${assets.filter(a=>a.kind==='private').length} private, ${assets.filter(a=>a.kind==='public').length} public)`);
