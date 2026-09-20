// Pull real daily OHLCV per asset from an *honest* Solana pool.
//
// Three traps this avoids, each of which silently corrupts the dataset:
//
//  1. ORIENTATION. Our token is often the QUOTE side of a pool ("WC / ANDURL").
//     Reading that pool's OHLCV naively returns the OTHER token's price.
//     Every request is pinned with ?token=<mint>.
//
//  2. DISHONEST POOLS. A thin pool can quote far from where an asset really
//     trades. We fetch several pools and let them vote: the MEDIAN last close
//     is the reference, and pools that disagree with it are dropped.
//
//  3. A BAD REFERENCE. Jupiter's `usdPrice` field is unreliable for thin
//     pre-IPO tokens — for OPENAI it reports $1144 while the executable swap
//     quote and every pool agree on ~$1701 (the token has 9 decimals). So the
//     pools decide, and Jupiter's field is recorded for comparison only.
import { readFileSync, writeFileSync } from 'node:fs';

const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
const STABLE = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',   // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',   // USDT
  'So11111111111111111111111111111111111111112',    // SOL
]);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = xs => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function gt(path) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(GT + path, { headers: { accept: 'application/json' } });
      if (r.status === 429) { await sleep(5000); continue; }
      if (r.ok) return await r.json();
    } catch {}
    await sleep(1200 * (i + 1));
  }
  return null;
}

const universe = JSON.parse(readFileSync('data/_raw-universe.json', 'utf8'));
const out = [];

for (const a of universe) {
  // ── candidate pools, ranked by depth, orientation and pairing ────────────
  const cands = [];
  for (const page of [1, 2]) {
    const res = await gt(`/tokens/${a.mint}/pools?page=${page}`);
    await sleep(2100);
    for (const p of res?.data || []) {
      const rel = p.relationships || {};
      const base = (rel.base_token?.data?.id || '').split('_').pop();
      const quote = (rel.quote_token?.data?.id || '').split('_').pop();
      const resv = +(p.attributes?.reserve_in_usd || 0);
      if (resv < 4000) continue;
      const isBase = base === a.mint;
      if (!isBase && quote !== a.mint) continue;
      cands.push({
        id: p.id.replace('solana_', ''), name: p.attributes?.name, resv,
        rank: resv * (isBase ? 1 : 0.25) * (STABLE.has(isBase ? quote : base) ? 1 : 0.3),
      });
    }
    if ((res?.data || []).length < 20) break;
  }
  cands.sort((x, y) => y.rank - x.rank);

  // ── fetch the top few, then let them vote on the real price ──────────────
  const got = [];
  for (const c of cands.slice(0, 5)) {
    const oh = await gt(`/pools/${c.id}/ohlcv/day?aggregate=1&limit=1000&currency=usd&token=${a.mint}`);
    await sleep(2100);
    const list = oh?.data?.attributes?.ohlcv_list;
    if (!list) continue;
    const rows = list.map(r => ({ t: r[0], c: +r[4] })).filter(r => r.c > 0)
                     .sort((x, y) => x.t - y.t);
    if (rows.length >= 40) got.push({ ...c, rows, last: rows.at(-1).c });
    if (got.length >= 4) break;
  }
  if (!got.length) {
    console.error(`  SKIP ${a.symbol.padEnd(10)} no pool with history (${cands.length} candidates)`);
    continue;
  }

  const truth = median(got.map(g => g.last));
  const agree = got.filter(g => Math.abs(g.last - truth) / truth <= 0.30);
  const pool = (agree.length ? agree : got)
    .sort((x, y) => (y.rows.length - x.rows.length) || (y.resv - x.resv))[0];

  const jupGap = Math.abs(truth - a.price) / a.price;
  out.push({
    ...a,
    price: +truth.toFixed(6), jupPrice: a.price, jupGap: +(jupGap * 100).toFixed(1),
    pool: pool.id, poolName: pool.name, poolResv: Math.round(pool.resv),
    pools: got.length, days: pool.rows.length, rows: pool.rows,
  });
  console.error(
    `  ok   ${a.symbol.padEnd(10)} ${String(pool.rows.length).padStart(4)}d  ` +
    `${(pool.name || '').slice(0, 18).padEnd(20)} $${truth.toFixed(2).padStart(9)}  ` +
    `${got.length}p` + (jupGap > 0.25 ? `   [!] jupiter says $${a.price.toFixed(2)}` : ''));
}

writeFileSync('data/_history.json', JSON.stringify(out));
console.error(`\n[history] ${out.length} assets  ` +
  `(${out.filter(x => x.kind === 'private').length} private / ` +
  `${out.filter(x => x.kind === 'public').length} public)`);
