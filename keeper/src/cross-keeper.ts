/* ───────────────────────────────────────────────────────────────────────────
   The cross keeper: moves every cross from its bell to closed.

   Everything it does is permissionless. It prices a cross once the bell's
   print is final, confirms the book in batches, clears after the auction,
   settles every order and offer, and closes the cross. Any user could do
   each of these steps themselves. The keeper is a convenience, not an
   authority: when it is down, crosses wait, and nobody loses anything.

   It also runs the backstop maker. When a cross opens its auction, the
   maker posts a standing offer at BACKSTOP.feeBps on the crowded side. The
   size comes from sdk/src/cross.ts, to cover the imbalance and no more. That
   offer caps what the crowded side pays; anyone who asks less fills first.

   If an issuer pause makes a token leg fail, the keeper settles the quote
   leg alone and retries the tokens on later passes.

   At the bell it also quotes each side's total on Jupiter, for the real
   xStock on mainnet, and writes the quotes beside the price, in a Memo of
   the price_cross transaction: the counterfactual a receipt shows next to
   the fill (sdk/src/counterfactual.ts).

   It also cranks the issuer-power drill markets in
   web/public/cross-drills.json (keeper/src/cross-drill.ts), when that file
   exists: no backstop and no counterfactual there, and a short keep, so a
   drill's escrow is visibly empty the same day.

     npm run cross:keeper               run until stopped (the service)
     npm run cross:keeper -- --once     one pass over every cross
     npm run cross:keeper -- --status   the market's crosses, by phase
   ─────────────────────────────────────────────────────────────────────────── */

import { existsSync, readFileSync } from 'node:fs';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, type TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { decodePrint, printPda } from '../../sdk/src/bell.ts';
import { clear as clearMath, emptyLadder, LADDER } from '../../sdk/src/cross.ts';
import {
  CROSS_ACCOUNT, CROSS_PROGRAM_ID, LEG_QUOTE, LEGS, OFFSETS, ataOf, cancelCrossIx, clearIx, closeCrossIx,
  confirmOrdersIx, decodeCross, decodeMarket, decodeOffer, decodeOrder, marketRef, offerPda, postOfferIx, priceCrossIx,
  settleOfferIx, settleOrderIx, type CrossAccount, type MarketRef,
} from '../../sdk/src/cross-ix.ts';
import {
  COUNTERFACTUAL_WINDOW_SECS, counterfactualMemoIx, MAINNET_USDC, type Counterfactual, type SwapQuote,
} from '../../sdk/src/counterfactual.ts';
import { parseSecret } from './wallet.ts';

const RPC = process.env.DEVNET_RPC ?? 'https://api.devnet.solana.com';
const MANIFEST = 'web/public/cross-devnet.json';
const DRILLS = 'web/public/cross-drills.json';
const PASS_MS = 20_000;
const BATCH = 6;
/** How long a settled cross stays open for the site to show it. */
const KEEP_SECS = 86_400;

const args = process.argv.slice(2);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { stopping = true; });

interface Manifest {
  market: string; maker: string; treasury: string; realMint: string;
  backstop: { feeBps: number; maxRaw: string; maxQuote: string };
  /** A drill market: no backstop, no counterfactual, and this keep instead of a day. */
  drill?: string; keepSecs?: number;
}

const conn = new Connection(RPC, 'confirmed');
const loadKey = (p: string) => parseSecret(readFileSync(p, 'utf8')).keypair;

async function send(signers: Keypair[], ixs: TransactionInstruction[], what: string): Promise<string | null> {
  try {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' });
    log(`  ${what}  ${sig}`);
    return sig;
  } catch (e) {
    const x = e as { logs?: string[]; transactionLogs?: string[] };
    const text = [...(x?.logs ?? []), ...(x?.transactionLogs ?? []), String(e)].join('\n');
    const code = /Error Code: (\w+)/.exec(text)?.[1] ?? (text.includes('paused') ? 'paused' : null);
    log(`  ${what} failed: ${code ?? String(e).slice(0, 160)}`);
    return null;
  }
}

const discFilter = (name: keyof typeof CROSS_ACCOUNT) => ({ memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(CROSS_ACCOUNT[name])) } });

async function crossesOf(m: MarketRef): Promise<{ address: PublicKey; c: CrossAccount }[]> {
  const accts = await conn.getProgramAccounts(CROSS_PROGRAM_ID, {
    filters: [discFilter('Cross'), { memcmp: { offset: OFFSETS.crossMarket, bytes: m.market.toBase58() } }],
  });
  return accts.map((a) => ({ address: a.pubkey, c: decodeCross(a.account.data) })).sort((a, b) => a.c.bellTs - b.c.bellTs);
}

async function ordersOf(cross: PublicKey) {
  const accts = await conn.getProgramAccounts(CROSS_PROGRAM_ID, {
    filters: [discFilter('Order'), { memcmp: { offset: OFFSETS.orderCross, bytes: cross.toBase58() } }],
  });
  return accts.map((a) => ({ address: a.pubkey, o: decodeOrder(a.account.data) }));
}

async function offersOf(cross: PublicKey) {
  const accts = await conn.getProgramAccounts(CROSS_PROGRAM_ID, {
    filters: [discFilter('Offer'), { memcmp: { offset: OFFSETS.offerCross, bytes: cross.toBase58() } }],
  });
  return accts.map((a) => ({ address: a.pubkey, f: decodeOffer(a.account.data) }));
}

/* ── the counterfactual ─────────────────────────────────────────────────── */

const JUPITER_QUOTE = 'https://lite-api.jup.ag/swap/v1/quote';
/** The Memo program charges by the byte: 124k units for a real counterfactual
    on devnet, 222k for the largest one readCounterfactual accepts. Set the
    limit rather than share the default 200k per instruction with the price. */
const PRICE_WITH_MEMO_CU = 600_000;
/** Taken at the bell, written when the cross is priced, by cross address. */
const quoted = new Map<string, Counterfactual>();

/** One ExactIn quote. Jupiter's refusal is an answer and is recorded; a
    network failure or a rate limit throws, and the next pass asks again. */
async function jupiterQuote(inputMint: string, outputMint: string, amount: bigint): Promise<SwapQuote> {
  const url = `${JUPITER_QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50&swapMode=ExactIn`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (r.status === 429 || r.status >= 500) throw new Error(`Jupiter answered ${r.status}`);
  const j = (await r.json().catch(() => ({}))) as {
    inAmount?: string; outAmount?: string; priceImpactPct?: string; error?: string; errorCode?: string;
    routePlan?: { swapInfo?: { label?: string } }[];
  };
  if (!r.ok || !j.inAmount || !j.outAmount) return { noRoute: String(j.error ?? j.errorCode ?? `HTTP ${r.status}`).slice(0, 120) };
  return {
    in: j.inAmount, out: j.outAmount, impactPct: Number(j.priceImpactPct ?? 0),
    route: (j.routePlan ?? []).map((p) => p.swapInfo?.label ?? '?').join(' > ').slice(0, 120),
  };
}

/** What each side's total would have got from a swap on mainnet, now. The
    devnet quote token has USDC's 6 decimals and the fixture NVDAx the real
    one's 8 and multiplier, so the atoms carry over unchanged. */
async function counterfactual(cross: PublicKey, c: CrossAccount, man: Manifest): Promise<Counterfactual> {
  const at = Math.floor(Date.now() / 1000);
  const [buy, sell] = await Promise.all([
    c.buyTotal > 0n ? jupiterQuote(MAINNET_USDC, man.realMint, c.buyTotal) : undefined,
    c.sellTotal > 0n ? jupiterQuote(man.realMint, MAINNET_USDC, c.sellTotal) : undefined,
  ]);
  return { cross: cross.toBase58(), at, venue: 'jupiter', mint: man.realMint, ...(buy && { buy }), ...(sell && { sell }) };
}

const describeQuote = (q: SwapQuote | undefined) => (!q ? 'none' : 'noRoute' in q ? `no route (${q.noRoute})` : `${q.in} → ${q.out} via ${q.route}`);

/** How much the backstop must offer, at its fee, to cover this imbalance. */
function backstopSize(c: CrossAccount, feeBps: number): bigint {
  const ladder = emptyLadder();
  ladder[feeBps] = 1n << 62n; // as if unlimited: what would it take?
  const r = clearMath(c.clearing.priceWad, c.clearing.buyIn, c.clearing.sellIn, ladder);
  return r.marginalNeed + 2n; // rounding room: an atom per leg
}

async function tokenBalance(account: PublicKey): Promise<bigint> {
  return conn.getTokenAccountBalance(account).then((r) => BigInt(r.value.amount)).catch(() => 0n);
}

async function pass(m: MarketRef, man: Manifest, cranker: Keypair, maker: Keypair | null): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const marketAcct = decodeMarket((await conn.getAccountInfo(m.market))!.data);
  for (const { address, c } of await crossesOf(m)) {
    if (stopping) return;
    const at = { day: c.day, kind: c.kind };
    const label = `${c.kind} of day ${c.day}`;
    if (c.phase !== 'collecting') quoted.delete(address.toBase58()); // priced, by us or by anyone
    switch (c.phase) {
      case 'collecting': {
        if (now < c.bellTs) break;
        // the alternative, as near the bell as this pass is
        const key = address.toBase58();
        if (!man.drill && !quoted.has(key) && now - c.bellTs <= COUNTERFACTUAL_WINDOW_SECS && (c.buyTotal > 0n || c.sellTotal > 0n)) {
          try {
            const cf = await counterfactual(address, c, man);
            quoted.set(key, cf);
            log(`  counterfactual for the ${label}, ${cf.at - c.bellTs}s after the bell: buy ${describeQuote(cf.buy)}; sell ${describeQuote(cf.sell)}`);
          } catch (e) {
            log(`  counterfactual for the ${label} not taken, asking again next pass: ${String(e).slice(0, 120)}`);
          }
        }
        const print = await conn.getAccountInfo(printPda(m.listing, c.day, c.kind)[0]);
        const status = print ? decodePrint(print.data).status : null;
        if (status === 'final' || status === 'missing') {
          const cf = status === 'final' ? quoted.get(key) : undefined;
          const ixs = cf
            ? [ComputeBudgetProgram.setComputeUnitLimit({ units: PRICE_WITH_MEMO_CU }), priceCrossIx(m, at), counterfactualMemoIx(cf)]
            : [priceCrossIx(m, at)];
          if (await send([cranker], ixs, `price the ${label} (${status} print)${cf ? ', its counterfactual beside it' : ''}`)) quoted.delete(key);
        } else if (now > c.bellTs + marketAcct.params.cancelAfterSecs) {
          await send([cranker], [cancelCrossIx(m, at)], `cancel the ${label}: no print in time`);
        }
        break;
      }
      case 'confirming': {
        const open = (await ordersOf(address)).filter((x) => x.o.status === 'open');
        for (let i = 0; i < open.length; i += BATCH) {
          await send([cranker], [confirmOrdersIx(m, { ...at, orders: open.slice(i, i + BATCH).map((x) => x.address) })], `confirm ${Math.min(BATCH, open.length - i)} order(s) of the ${label}`);
        }
        break;
      }
      case 'auction': {
        if (maker && now < c.auctionEnd) {
          const offer = offerPda(address, maker.publicKey, 0);
          if (!(await conn.getAccountInfo(offer))) {
            const side = c.crowded === 'buyers' ? 'sell' : 'buy';
            const mint = side === 'sell' ? m.mint : m.quoteMint;
            const program = side === 'sell' ? m.mintProgram : m.quoteProgram;
            const cap = side === 'sell' ? BigInt(man.backstop.maxRaw) : BigInt(man.backstop.maxQuote);
            const held = await tokenBalance(ataOf(maker.publicKey, mint, program));
            const need = backstopSize(c, man.backstop.feeBps);
            const size = [need, cap, held].reduce((a, b) => (a < b ? a : b));
            const min = side === 'sell' ? marketAcct.params.minOrderRaw : marketAcct.params.minOrderQuote;
            if (size >= min) {
              await send([maker], [postOfferIx(m, { maker: maker.publicKey, ...at, nonce: 0, side, size, feeBps: man.backstop.feeBps })],
                `backstop: ${size} ${side === 'sell' ? 'raw NVDAx' : 'quote'} at ${man.backstop.feeBps} bp into the ${label}`);
            }
          }
        }
        if (now >= c.auctionEnd) await send([cranker], [clearIx(m, at)], `clear the ${label}`);
        break;
      }
      case 'settling':
      case 'cancelled': {
        // The cross counts what it has paid out, so a finished one costs no reads.
        if (c.nSettled < c.nOrders || c.nOffersSettled < c.nOffers) {
          for (const { o } of await ordersOf(address)) {
            if (stopping) return;
            const ok = await send([cranker], [settleOrderIx(m, { cranker: cranker.publicKey, ...at, owner: o.owner, nonce: o.nonce, legs: LEGS })], `settle ${o.side} ${o.amount} (${o.status}) of the ${label}`);
            if (!ok && !(o.legs & LEG_QUOTE)) {
              // an issuer pause holds token legs, never quote refunds
              await send([cranker], [settleOrderIx(m, { cranker: cranker.publicKey, ...at, owner: o.owner, nonce: o.nonce, legs: LEG_QUOTE })], '  settle its quote leg alone');
            }
          }
          for (const { f } of await offersOf(address)) {
            await send([cranker], [settleOfferIx(m, { cranker: cranker.publicKey, ...at, maker: f.maker, nonce: f.nonce, legs: LEGS })], `settle a ${f.feeBps} bp offer of the ${label}`);
          }
        }
        // Keep a paid-out cross a day before closing it: its clearing is what
        // the site shows as the bell's result, and what receipts are
        // computed from. Its rent comes back either way.
        if (now < (c.clearedAt || c.bellTs) + (man.keepSecs ?? KEEP_SECS)) break;
        const fresh = decodeCross((await conn.getAccountInfo(address))!.data);
        if (fresh.nSettled === fresh.nOrders && fresh.nOffersSettled === fresh.nOffers) {
          await send([cranker], [closeCrossIx(m, { cranker: cranker.publicKey, ...at, createdBy: fresh.createdBy, treasury: new PublicKey(man.treasury) })], `close the ${label}`);
        }
        break;
      }
    }
  }
}

async function status(m: MarketRef): Promise<void> {
  const crosses = await crossesOf(m);
  console.log(`market ${m.market.toBase58()}: ${crosses.length} open cross(es)`);
  for (const { c } of crosses) {
    const cl = c.clearing;
    console.log(`  ${new Date(c.bellTs * 1000).toISOString().slice(0, 16)}Z ${c.kind.padEnd(5)} ${c.phase.padEnd(10)} ${c.nOrders} order(s), ${c.nOffers} offer(s)` +
      (c.phase === 'settling' ? `  ${cl.crowded}, fee ${cl.feeBps} bp, buyers ${cl.buyIn} → ${cl.buyTokens} raw, sellers ${cl.sellIn} → ${cl.sellQuote} quote` : ''));
  }
}

async function refOf(man: Manifest): Promise<MarketRef> {
  const marketKey = new PublicKey(man.market);
  const info = await conn.getAccountInfo(marketKey);
  if (!info) throw new Error(`market ${man.market} is not on this cluster`);
  return marketRef(marketKey, decodeMarket(info.data));
}

/** The drill markets, re-read each pass so a new drill needs no restart. */
function drills(): Manifest[] {
  if (!existsSync(DRILLS)) return [];
  try {
    return (JSON.parse(readFileSync(DRILLS, 'utf8')) as { drills: Manifest[] }).drills ?? [];
  } catch (e) {
    log(`${DRILLS} unreadable: ${String(e).slice(0, 120)}`);
    return [];
  }
}

async function main(): Promise<void> {
  if (!existsSync(MANIFEST)) throw new Error(`${MANIFEST} is missing: run npm run cross:devnet -- --apply`);
  const man = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
  const m = await refOf(man);
  if (args.includes('--status')) {
    await status(m);
    for (const d of drills()) await status(await refOf(d)).catch((e) => console.log(`drill ${d.drill}: ${String(e).slice(0, 120)}`));
    return;
  }
  const cranker = loadKey(process.env.CROSS_CRANKER_KEYPAIR ?? 'keeper/.devnet/bell-poster.json');
  const maker = existsSync('keeper/.devnet/bell-maker.json') ? loadKey('keeper/.devnet/bell-maker.json') : null;
  log(`cross keeper: market ${man.market}, cranker ${cranker.publicKey.toBase58()}, backstop ${maker?.publicKey.toBase58() ?? 'off'} at ${man.backstop.feeBps} bp; ladder ${LADDER} buckets`);
  const drillRefs = new Map<string, MarketRef>();
  do {
    try {
      await pass(m, man, cranker, maker);
    } catch (e) {
      log(`pass failed: ${String(e).slice(0, 200)}`);
    }
    for (const d of drills()) {
      try {
        if (!drillRefs.has(d.market)) {
          drillRefs.set(d.market, await refOf(d));
          log(`cross keeper: also the ${d.drill} drill, market ${d.market}`);
        }
        await pass(drillRefs.get(d.market)!, d, cranker, null);
      } catch (e) {
        log(`${d.drill} drill pass failed: ${String(e).slice(0, 200)}`);
      }
    }
    if (!args.includes('--once')) await sleep(PASS_MS);
  } while (!stopping && !args.includes('--once'));
}

main().then(() => process.exit(0), (e) => {
  console.error(e);
  process.exit(1);
});
