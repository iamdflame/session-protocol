// What does it actually cost to move the imbalance?
//
// The protocol's central claim is that a boundary is a book entry when the two
// classes are the same size, and that only the *difference* between them ever
// reaches a market. That claim is worth nothing if the difference cannot be
// filled at anything near the mark, so this prices it against live Jupiter
// routes across the xStock universe at a ladder of notionals.
//
// Note what is being measured. This is not the cost of running a session
// strategy in a brokerage account — that would be the full position, twice a
// day, ~250 times a year, which is exactly what makes the trade impossible
// there. This is the cost of the residual.
//
//   node research/executability.mjs [--notionals 1000,10000,50000]

import { readFileSync, writeFileSync } from 'node:fs';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUP = 'https://lite-api.jup.ag/swap/v1/quote';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const NOTIONALS = arg('notionals', '1000,10000,50000,250000').split(',').map(Number);

async function quote(inMint, outMint, amount) {
  const url = `${JUP}?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}` +
              `&slippageBps=300&onlyDirectRoutes=false`;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      if (r.status === 429) { await sleep(2500); continue; }
      return null;
    } catch { await sleep(1200); }
  }
  return null;
}

const universe = JSON.parse(readFileSync('data/_raw-universe.json', 'utf8'))
  .filter(a => a.kind === 'public')
  .sort((a, b) => b.liquidity - a.liquidity)
  .slice(0, 10);

console.log(`\nIMBALANCE EXECUTION COST — live Jupiter routes, ${new Date().toISOString().slice(0, 16)}Z`);
console.log('Round trip: USDC -> xStock -> USDC. This is what the vault pays to');
console.log('re-point the *residual* between the two classes, not the whole book.\n');

const head = 'asset'.padEnd(10) + 'pool liq'.padStart(12) +
  NOTIONALS.map(n => `$${n >= 1000 ? `${n / 1000}k` : n}`.padStart(11)).join('');
console.log(head);
console.log('─'.repeat(head.length));

const results = [];
for (const a of universe) {
  const row = { symbol: a.symbol, liquidity: a.liquidity, costs: {} };
  let line = a.symbol.padEnd(10) + `$${Math.round(a.liquidity).toLocaleString()}`.padStart(12);

  for (const usd of NOTIONALS) {
    const buy = await quote(USDC, a.mint, Math.round(usd * 1e6));
    await sleep(350);
    if (!buy?.outAmount) { line += 'no route'.padStart(11); row.costs[usd] = null; continue; }

    // sell straight back to measure the true round trip, spread included
    const sell = await quote(a.mint, USDC, buy.outAmount);
    await sleep(350);
    if (!sell?.outAmount) { line += 'no route'.padStart(11); row.costs[usd] = null; continue; }

    const back = Number(sell.outAmount) / 1e6;
    const roundTripBps = ((usd - back) / usd) * 10_000;
    row.costs[usd] = +roundTripBps.toFixed(1);
    line += `${roundTripBps.toFixed(0)}bp`.padStart(11);
  }
  console.log(line);
  results.push(row);
}

console.log('─'.repeat(head.length));
const at10k = results.map(r => r.costs[10000]).filter(v => v != null);
const median = xs => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
if (at10k.length) {
  console.log(`\nmedian round trip at $10k: ${median(at10k).toFixed(0)}bp`);
  console.log('\nHalf of that is the one-way cost the vault pays on the residual.');
  console.log('A balanced book pays none of it: the handoff never leaves the vault.');
  console.log('For contrast, a brokerage running the same strategy pays the one-way');
  console.log('cost on the FULL position, twice a day, ~500 times a year.');
}

writeFileSync('data/executability.json', JSON.stringify({
  generated: new Date().toISOString(), notionals: NOTIONALS, results,
}, null, 1));
console.log('\nwrote data/executability.json');
