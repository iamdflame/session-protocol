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

     npm run cross:keeper               run until stopped (the service)
     npm run cross:keeper -- --once     one pass over every cross
     npm run cross:keeper -- --status   the market's crosses, by phase
   ─────────────────────────────────────────────────────────────────────────── */

import { existsSync, readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import { decodePrint, printPda } from '../../sdk/src/bell.ts';
import { clear as clearMath, emptyLadder, LADDER } from '../../sdk/src/cross.ts';
import {
  CROSS_ACCOUNT, CROSS_PROGRAM_ID, LEG_QUOTE, LEGS, OFFSETS, ataOf, cancelCrossIx, clearIx, closeCrossIx,
  confirmOrdersIx, decodeCross, decodeMarket, decodeOffer, decodeOrder, marketRef, offerPda, postOfferIx, priceCrossIx,
  settleOfferIx, settleOrderIx, type CrossAccount, type MarketRef,
} from '../../sdk/src/cross-ix.ts';
import { parseSecret } from './wallet.ts';

const RPC = process.env.DEVNET_RPC ?? 'https://api.devnet.solana.com';
const MANIFEST = 'web/public/cross-devnet.json';
const PASS_MS = 20_000;
const BATCH = 6;

const args = process.argv.slice(2);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { stopping = true; });

interface Manifest {
  market: string; maker: string; treasury: string;
  backstop: { feeBps: number; maxRaw: string; maxQuote: string };
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
    switch (c.phase) {
      case 'collecting': {
        if (now < c.bellTs) break;
        const print = await conn.getAccountInfo(printPda(m.listing, c.day, c.kind)[0]);
        const status = print ? decodePrint(print.data).status : null;
        if (status === 'final' || status === 'missing') {
          await send([cranker], [priceCrossIx(m, at)], `price the ${label} (${status} print)`);
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
        const orders = await ordersOf(address);
        for (const { o } of orders) {
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

async function main(): Promise<void> {
  if (!existsSync(MANIFEST)) throw new Error(`${MANIFEST} is missing: run npm run cross:devnet -- --apply`);
  const man = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
  const marketKey = new PublicKey(man.market);
  const info = await conn.getAccountInfo(marketKey);
  if (!info) throw new Error(`market ${man.market} is not on this cluster`);
  const m = marketRef(marketKey, decodeMarket(info.data));
  if (args.includes('--status')) return status(m);
  const cranker = loadKey(process.env.CROSS_CRANKER_KEYPAIR ?? 'keeper/.devnet/bell-poster.json');
  const maker = existsSync('keeper/.devnet/bell-maker.json') ? loadKey('keeper/.devnet/bell-maker.json') : null;
  log(`cross keeper: market ${man.market}, cranker ${cranker.publicKey.toBase58()}, backstop ${maker?.publicKey.toBase58() ?? 'off'} at ${man.backstop.feeBps} bp; ladder ${LADDER} buckets`);
  do {
    try {
      await pass(m, man, cranker, maker);
    } catch (e) {
      log(`pass failed: ${String(e).slice(0, 200)}`);
    }
    if (!args.includes('--once')) await sleep(PASS_MS);
  } while (!stopping && !args.includes('--once'));
}

main().then(() => process.exit(0), (e) => {
  console.error(e);
  process.exit(1);
});
