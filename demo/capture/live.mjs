/* ───────────────────────────────────────────────────────────────────────────
   After the bell: read today's open cross from the chain and write the
   figures the video shows into demo/video/src/live.json.

     node demo/capture/live.mjs [cross-address]

   Nothing here is typed in by hand. The print, the clearing, the Jupiter
   comparison, Ade's fill (from the page's own note, recomputed with the
   program's arithmetic) and the drill record all come from devnet and from
   web/public/cross-drills.json. Anything the chain has not produced yet is
   left out, and `ready` stays false until the cross has cleared.
   ─────────────────────────────────────────────────────────────────────────── */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { decimalPrice, decodePrint } from '../../sdk/src/bell.ts';
import { buyerLeg, WAD } from '../../sdk/src/cross.ts';
import { decodeCross } from '../../sdk/src/cross-ix.ts';
import { edgeBps } from '../../sdk/src/counterfactual.ts';
import { checkPrint, findCounterfactual } from '../../sdk/src/receipt.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
const OUT = join(ROOT, 'demo/video/src/live.json');
const man = JSON.parse(readFileSync(join(ROOT, 'web/public/cross-devnet.json'), 'utf8'));
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const address = new PublicKey(process.argv[2] ?? 'GdN6aYz68FBYxmwjVVUbJ9PEXrsku5nsDj7S18uX7PAb');
const retry = async (fn, n = 5) => { for (let i = 1; ; i++) { try { return await fn(); } catch (e) { if (i >= n) throw e; await new Promise((r) => setTimeout(r, 2000 * i)); } } };

const prev = JSON.parse(readFileSync(OUT, 'utf8'));
const c = decodeCross((await retry(() => conn.getAccountInfo(address))).data);
const m = c.multiplierWad || WAD;
const shown = (raw) => Number((raw * m) / WAD) / 1e8;
const usd = (q) => Number(q) / 1e6;
const out = { ...prev, cross: address.toBase58(), phase: c.phase };

out.book = { buyersUsd: usd(c.buyTotal), sellersNvdax: shown(c.sellTotal), orders: c.nOrders };
if (c.pricedAt) {
  const printInfo = await retry(() => conn.getAccountInfo(c.print));
  const p = decodePrint(printInfo.data);
  const price = Number(decimalPrice(p.equity.price, p.equity.expo));
  const ms = Number(p.equity.feedTsUs / 1000n) - c.bellTs * 1000;
  out.print = {
    price: price.toFixed(2), exact: decimalPrice(p.equity.price, p.equity.expo), simulated: p.simulated,
    fromBell: `${(ms / 1000).toFixed(1)} s`, atUtc: new Date(Number(p.equity.feedTsUs / 1000n)).toISOString(),
  };
  out.book.sellersUsd = shown(c.sellTotal) * price;
  const check = await checkPrint(conn, c.print, p);
  if (!('missing' in check)) out.print = { ...out.print, signature: check.signature, verifiedHere: check.verifiedHere, precompile: check.precompile, matchesPrint: check.matchesPrint };
}
if (c.phase === 'settling') {
  const cl = c.clearing;
  out.clearing = {
    crowded: cl.crowded, feeBps: cl.feeBps,
    buyersPut: usd(cl.buySpent), buyersGot: shown(cl.buyTokens), sellersPut: shown(cl.sellSpent), sellersGot: usd(cl.sellQuote),
  };
  const history = await retry(() => conn.getSignaturesForAddress(address, { limit: 200 }));
  const cf = await findCounterfactual(conn, address, c, history, man.keeper);
  if ('cf' in cf) {
    const side = (q, i, o) => (q && 'out' in q ? edgeBps(i, o, BigInt(q.in), BigInt(q.out)) : null);
    out.swap = {
      memoSignature: cf.signature, quotedAt: new Date(cf.cf.at * 1000).toISOString(),
      buyEdgeBps: side(cf.cf.buy, cl.buySpent, cl.buyTokens), sellEdgeBps: side(cf.cf.sell, cl.sellSpent, cl.sellQuote),
      buyRoute: cf.cf.buy && 'route' in cf.cf.buy ? cf.cf.buy.route : null,
    };
  } else out.swap = { missing: cf.why ?? cf.missing ?? 'untrusted' };
  // Ade: the order the recorded browser placed, recomputed with the program's arithmetic
  const notesFile = join(ROOT, 'demo/captures/notes.json');
  if (existsSync(notesFile)) {
    const note = JSON.parse(readFileSync(notesFile, 'utf8')).find((n) => n.cross === address.toBase58());
    if (note) {
      const limit = BigInt(note.limitE8);
      const inBand = limit === 0n || c.priceE8 <= limit;
      const [spent, got] = inBand ? buyerLeg(BigInt(note.amount), cl) : [0n, 0n];
      out.ade = { order: note.order, spent: usd(spent), got: shown(got) };
    }
  }
}
const drills = JSON.parse(readFileSync(join(ROOT, 'web/public/cross-drills.json'), 'utf8'));
out.drills = Object.fromEntries(drills.runs.map((r) => [r.drill, { result: r.result ?? 'pending', why: r.why ?? null, steps: r.steps.map((st) => ({ at: st.at, what: st.what, signature: st.signature ?? null })) }]));
const still = join(ROOT, 'demo/captures/stills/receipt-full.png');
if (existsSync(still)) out.receiptHeight = readFileSync(still).readUInt32BE(20);
out.ready = c.phase === 'settling' && !!out.print?.signature;
out.writtenAt = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify({ phase: c.phase, ready: out.ready, print: out.print, clearing: out.clearing, swap: out.swap, ade: out.ade, drills: Object.fromEntries(Object.entries(out.drills).map(([k, v]) => [k, v.result])) }, null, 1));
