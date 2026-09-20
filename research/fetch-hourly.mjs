// Hourly on-chain closes, paginated backwards, for the session study.
//
// Daily candles cannot answer the question — the whole point is what happens
// *inside* a day, either side of the 09:30 and 16:00 ET boundaries. GeckoTerminal
// caps a page at 1000 candles (~42 days hourly), so we walk `before_timestamp`
// back until we have enough history.
//
// Pools are not rediscovered: we reuse the ones the daily pipeline already
// vetted for orientation and median-of-pools price sanity.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
const PAGES = +(process.env.PAGES || 7);          // ~42 days each
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gt(path) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(GT + path, { headers: { accept: 'application/json' } });
      if (r.status === 429) { await sleep(6000); continue; }
      if (r.ok) return await r.json();
    } catch {}
    await sleep(1500 * (i + 1));
  }
  return null;
}

const src = existsSync('data/_history.json') ? 'data/_history.json' : null;
if (!src) { console.error('run the daily pipeline first (npm run data)'); process.exit(1); }
const daily = JSON.parse(readFileSync(src, 'utf8'));

const out = [];
for (const a of daily) {
  const seen = new Map();                          // ts -> close, dedup across pages
  let before = Math.floor(Date.now() / 1000);
  for (let page = 0; page < PAGES; page++) {
    const oh = await gt(`/pools/${a.pool}/ohlcv/hour?aggregate=1&limit=1000` +
                        `&currency=usd&token=${a.mint}&before_timestamp=${before}`);
    await sleep(2300);
    const list = oh?.data?.attributes?.ohlcv_list;
    if (!list || !list.length) break;
    let oldest = before;
    for (const r of list) {
      const t = r[0], c = +r[4];
      if (c > 0) seen.set(t, c);
      if (t < oldest) oldest = t;
    }
    if (oldest >= before) break;                   // no progress, stop
    before = oldest;
  }

  const rows = [...seen.entries()].map(([t, c]) => [t, c]).sort((x, y) => x[0] - y[0]);
  if (rows.length < 400) { console.error(`  skip ${a.symbol.padEnd(10)} only ${rows.length}h`); continue; }

  const days = (rows.at(-1)[0] - rows[0][0]) / 86400;
  out.push({ symbol: a.symbol, mint: a.mint, kind: a.kind, pool: a.pool,
             liquidity: a.liquidity, rows });
  console.error(`  ok   ${a.symbol.padEnd(10)} ${String(rows.length).padStart(5)}h  ` +
                `${days.toFixed(0).padStart(3)}d  ${new Date(rows[0][0]*1e3).toISOString().slice(0,10)}` +
                ` -> ${new Date(rows.at(-1)[0]*1e3).toISOString().slice(0,10)}`);
}

writeFileSync('data/_hourly.json', JSON.stringify({ generated: new Date().toISOString(), assets: out }));
console.error(`\n[hourly] ${out.length} assets, ` +
  `${out.reduce((s, a) => s + a.rows.length, 0).toLocaleString()} hourly closes`);
