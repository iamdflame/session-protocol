/* ───────────────────────────────────────────────────────────────────────────
   The issuer-power drills: on devnet, at a real NYSE bell.

   An xStock's issuer can pause its mint and change its multiplier. The cross
   has to survive both with nobody losing an atom. LiteSVM already proves it
   on the real NVDAx bytes (tests/integration/tests/cross.rs). These drills
   run it in public, where anyone can read every transaction, on two fixture
   mints of their own so the demo market is untouched:

     pause       Orders go in, then the issuer pauses the mint. The cross
                 prices and clears, since neither moves a token. Settling
                 the tokens fails, so the keeper pays every quote leg alone
                 and the tokens wait in escrow. This drill then resumes the
                 mint, the tokens follow, the keeper closes the cross, and
                 both escrows read zero.
     multiplier  Orders go in, then the issuer schedules a new multiplier
                 for five minutes after the bell. Pricing will not guess
                 which multiplier the bell meant: it cancels the cross, and
                 the keeper refunds everyone whole. Both escrows read zero.

   The keeper cranks both markets alongside the demo market, since they are
   listed in web/public/cross-drills.json. This script only does what an
   issuer and two traders would, then watches and writes down what happened.

     npm run cross:drill -- --setup [--apply]  mints, markets and traders; writes web/public/cross-drills.json
     npm run cross:drill -- --arm [--apply]    orders into the next open, then the pause and the new multiplier
     npm run cross:drill -- --watch            until both finish: resume once the quote legs are paid, then report
     npm run cross:drill -- --status
   ─────────────────────────────────────────────────────────────────────────── */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  createInitializeMetadataPointerInstruction, createInitializeMint2Instruction, createInitializePausableConfigInstruction,
  createInitializePermanentDelegateInstruction, createInitializeScaledUiAmountConfigInstruction, createMintToInstruction,
  createPauseInstruction, createResumeInstruction, createUpdateMultiplierDataInstruction, ExtensionType, getMintLen,
  LENGTH_SIZE, TOKEN_2022_PROGRAM_ID, TYPE_SIZE,
} from '@solana/spl-token';
import { createInitializeInstruction, pack, type TokenMetadata } from '@solana/spl-token-metadata';
import bs58 from 'bs58';
import { bellTs, etDay, listingPda, type BellKind } from '../../sdk/src/bell.ts';
import { multiplierWad, readScaledUi, WAD } from '../../sdk/src/cross.ts';
import {
  ataOf, CROSS_ACCOUNT, CROSS_PROGRAM_ID, createMarketIx, crossPda, decodeCross, decodeMarket, decodeOrder, LEG_QUOTE, LEG_RAW,
  marketPda, marketRef, OFFSETS, orderPda, placeOrderIx, quoteEscrowPda, rawEscrowPda, TOKEN_PROGRAM, type MarketRef,
} from '../../sdk/src/cross-ix.ts';
import { createAtaIdempotentIx } from '../../sdk/src/ix.ts';
import { parseSecret } from './wallet.ts';

const RPC = process.env.DEVNET_RPC ?? 'https://api.devnet.solana.com';
const DIR = 'keeper/.devnet';
const MAIN = 'web/public/cross-devnet.json';
const OUT = 'web/public/cross-drills.json';
/** NVDAx's own multiplier, as on the demo fixture. */
const NVDAX_MULTIPLIER = 1.001701196801074;
/** What the multiplier drill schedules, and when: inside the pricing guard. */
const DRILL_MULTIPLIER = 1.0025;
const AFTER_BELL = 300;
/** A drill cross closes this long after it clears, so its escrow is visibly empty the same day. */
const KEEP_SECS = 600;

const DRILLS = {
  pause: { buyUsd: 40, sellNvdax: 0.2, title: 'the issuer pauses the mint before the bell' },
  multiplier: { buyUsd: 30, sellNvdax: 0.1, title: 'the issuer schedules a new multiplier five minutes after the bell' },
} as const;
type Drill = keyof typeof DRILLS;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const conn = new Connection(RPC, 'confirmed');
const load = (path: string): Keypair => parseSecret(readFileSync(path, 'utf8')).keypair;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function localKey(name: string): Keypair {
  const path = `${DIR}/${name}.json`;
  if (existsSync(path)) return load(path);
  mkdirSync(DIR, { recursive: true });
  const k = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 });
  console.log(`  created ${path} (${k.publicKey.toBase58()})`);
  return k;
}

async function send(signers: Keypair[], ixs: TransactionInstruction[], what: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' });
      log(`  ok    ${what}  ${sig}`);
      return sig;
    } catch (e) {
      if (attempt >= 4) throw e;
      log(`  retry ${what} (${String(e).slice(0, 120)})`);
      await sleep(2_000 * attempt);
    }
  }
}

interface DrillManifest {
  drill: Drill; title: string; market: string; mint: string; mintProgram: string; quoteMint: string; quoteProgram: string;
  rawEscrow: string; quoteEscrow: string; listing: string; treasury: string; maker: string; realMint: string;
  keeper: string; backstop: { feeBps: number; maxRaw: string; maxQuote: string }; keepSecs: number;
}
interface Step { at: string; what: string; signature?: string; detail?: Record<string, unknown> }
interface Run { drill: Drill; bell: string; day: number; kind: BellKind; cross: string; steps: Step[]; result?: 'passed' | 'failed'; why?: string }
interface Doc { note: string; drills: DrillManifest[]; runs: Run[]; writtenAt: string }

const readDoc = (): Doc | null => (existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) as Doc : null);
const writeDoc = (d: Doc) => writeFileSync(OUT, JSON.stringify({ ...d, writtenAt: new Date().toISOString() }, null, 2) + '\n');
const step = (run: Run, what: string, signature?: string, detail?: Record<string, unknown>) => {
  run.steps.push({ at: new Date().toISOString(), what, ...(signature && { signature }), ...(detail && { detail }) });
  log(`  ${run.drill}: ${what}${signature ? `  ${signature}` : ''}`);
};

/* ── setup ──────────────────────────────────────────────────────────────── */

async function setup(): Promise<void> {
  const admin = load(process.env.DEPLOY_KEYPAIR ?? `${homedir()}/.config/solana/id.json`);
  const operator = load(`${DIR}/operator.json`);
  const main = JSON.parse(readFileSync(MAIN, 'utf8')) as Record<string, any>;
  const mainMarket = decodeMarket((await conn.getAccountInfo(new PublicKey(main.market)))!.data);
  const alice = load(`${DIR}/demo-alice.json`);
  const bob = load(`${DIR}/demo-bob.json`);
  const quoteMint = new PublicKey(main.quoteMint);
  const out: DrillManifest[] = [];

  for (const drill of Object.keys(DRILLS) as Drill[]) {
    const mint = localKey(`drill-${drill}-mint`);
    const market = marketPda(mint.publicKey);
    console.log(`\n${drill}: mint ${mint.publicKey.toBase58()}, market ${market.toBase58()}`);
    if (!(await conn.getAccountInfo(mint.publicKey))) {
      console.log('  todo  create the drill mint, shaped like NVDAx');
      if (apply) {
        const extensions = [ExtensionType.MetadataPointer, ExtensionType.ScaledUiAmountConfig, ExtensionType.PausableConfig, ExtensionType.PermanentDelegate];
        const metadata: TokenMetadata = {
          mint: mint.publicKey, name: `NVDAx (SESSION drill: ${drill})`, symbol: 'NVDAx', uri: '',
          additionalMetadata: [['shaped-like', main.realMint]],
        };
        const space = getMintLen(extensions);
        const lamports = await conn.getMinimumBalanceForRentExemption(space + TYPE_SIZE + LENGTH_SIZE + pack(metadata).length);
        await send([operator, mint], [
          SystemProgram.createAccount({ fromPubkey: operator.publicKey, newAccountPubkey: mint.publicKey, space, lamports, programId: TOKEN_2022_PROGRAM_ID }),
          createInitializeMetadataPointerInstruction(mint.publicKey, operator.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
          createInitializeScaledUiAmountConfigInstruction(mint.publicKey, operator.publicKey, NVDAX_MULTIPLIER, TOKEN_2022_PROGRAM_ID),
          createInitializePausableConfigInstruction(mint.publicKey, operator.publicKey, TOKEN_2022_PROGRAM_ID),
          createInitializePermanentDelegateInstruction(mint.publicKey, operator.publicKey, TOKEN_2022_PROGRAM_ID),
          createInitializeMint2Instruction(mint.publicKey, 8, operator.publicKey, operator.publicKey, TOKEN_2022_PROGRAM_ID),
          createInitializeInstruction({
            programId: TOKEN_2022_PROGRAM_ID, mint: mint.publicKey, metadata: mint.publicKey,
            mintAuthority: operator.publicKey, updateAuthority: operator.publicKey,
            name: metadata.name, symbol: metadata.symbol, uri: metadata.uri,
          }),
        ], `create the ${drill} drill mint`);
      }
    } else console.log('  have  mint');

    if (!(await conn.getAccountInfo(market))) {
      console.log('  todo  create its market, on the NVDA listing, with the demo market\'s parameters');
      if (apply) {
        await send([admin], [createMarketIx({
          admin: admin.publicKey, listing: listingPda('NVDA')[0], mint: mint.publicKey, quoteMint,
          mintProgram: TOKEN_2022_PROGRAM_ID, quoteProgram: TOKEN_PROGRAM, params: mainMarket.params,
        })], `create the ${drill} drill market`);
      }
    } else console.log('  have  market');

    // the traders: SOL for rent and fees, quote for the buyer, drill tokens for the seller
    const aliceQuote = ataOf(alice.publicKey, quoteMint, TOKEN_PROGRAM);
    const bobRaw = ataOf(bob.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID);
    const held = await conn.getTokenAccountBalance(bobRaw).then((r) => BigInt(r.value.amount)).catch(() => 0n);
    if (held < 10n ** 8n) {
      console.log('  todo  fund the drill traders');
      if (apply) {
        const ixs: TransactionInstruction[] = [
          createAtaIdempotentIx(operator.publicKey, alice.publicKey, quoteMint, TOKEN_PROGRAM),
          createMintToInstruction(quoteMint, aliceQuote, operator.publicKey, 200n * 10n ** 6n, [], TOKEN_PROGRAM),
          createAtaIdempotentIx(operator.publicKey, bob.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
          createMintToInstruction(mint.publicKey, bobRaw, operator.publicKey, 10n ** 8n, [], TOKEN_2022_PROGRAM_ID),
        ];
        for (const who of [alice, bob]) {
          if ((await conn.getBalance(who.publicKey)) < 0.03 * LAMPORTS_PER_SOL) {
            ixs.push(SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: who.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }));
          }
        }
        await send([operator], ixs, `fund the ${drill} drill traders`);
      }
    } else console.log('  have  funded traders');

    out.push({
      drill, title: DRILLS[drill].title, market: market.toBase58(), mint: mint.publicKey.toBase58(),
      mintProgram: TOKEN_2022_PROGRAM_ID.toBase58(), quoteMint: quoteMint.toBase58(), quoteProgram: TOKEN_PROGRAM.toBase58(),
      rawEscrow: rawEscrowPda(market).toBase58(), quoteEscrow: quoteEscrowPda(market).toBase58(), listing: main.listing,
      treasury: main.treasury, maker: main.maker, realMint: main.realMint, keeper: main.keeper,
      backstop: { feeBps: main.backstop.feeBps, maxRaw: '0', maxQuote: '0' }, keepSecs: KEEP_SECS,
    });
  }

  if (apply) {
    const prev = readDoc();
    writeDoc({
      note: 'Written by `npm run cross:drill`. Issuer-power drills on devnet: fixture mints of their own, cranked by the same keeper, at real bells.',
      drills: out, runs: prev?.runs ?? [], writtenAt: '',
    });
    console.log(`\n  wrote ${OUT}`);
  }
}

/* ── arm ────────────────────────────────────────────────────────────────── */

function nextOpen(now: number, freeze: number): { day: number; kind: BellKind; ts: number } {
  for (let d = etDay(now); d < etDay(now) + 12; d++) {
    const ts = bellTs(d, 'open');
    if (ts !== null && ts - freeze > now + 60) return { day: d, kind: 'open', ts };
  }
  throw new Error('no open in the next twelve days');
}

async function refOf(d: DrillManifest): Promise<{ ref: MarketRef; freeze: number }> {
  const m = decodeMarket((await conn.getAccountInfo(new PublicKey(d.market)))!.data);
  return { ref: marketRef(new PublicKey(d.market), m), freeze: Number(m.params.freezeSecs) };
}

async function arm(): Promise<void> {
  const doc = readDoc();
  if (!doc) throw new Error(`${OUT} is missing: run --setup --apply first`);
  const operator = load(`${DIR}/operator.json`);
  const alice = load(`${DIR}/demo-alice.json`);
  const bob = load(`${DIR}/demo-bob.json`);
  for (const d of doc.drills) {
    const { ref, freeze } = await refOf(d);
    const b = nextOpen(Math.floor(Date.now() / 1000), freeze);
    const cross = crossPda(ref.market, b.day, b.kind);
    if (doc.runs.some((r) => r.drill === d.drill && r.cross === cross.toBase58())) {
      console.log(`${d.drill}: already armed for the ${b.kind} of ${new Date(b.ts * 1000).toISOString()}`);
      continue;
    }
    console.log(`${d.drill}: arm the ${b.kind} at ${new Date(b.ts * 1000).toISOString()}, cross ${cross.toBase58()}`);
    if (!apply) continue;
    const run: Run = { drill: d.drill, bell: new Date(b.ts * 1000).toISOString(), day: b.day, kind: b.kind, cross: cross.toBase58(), steps: [] };
    const scaled = readScaledUi((await conn.getAccountInfo(ref.mint))!.data);
    const m = (scaled && scaled !== 'malformed' ? multiplierWad(scaled.currentBits) : null) ?? WAD;
    const buy = BigInt(DRILLS[d.drill].buyUsd) * 10n ** 6n;
    const sell = (BigInt(Math.round(DRILLS[d.drill].sellNvdax * 1e8)) * WAD) / m;
    step(run, `alice buys $${DRILLS[d.drill].buyUsd}`,
      await send([alice], [placeOrderIx(ref, { owner: alice.publicKey, day: b.day, kind: b.kind, nonce: 0, side: 'buy', amount: buy })], `${d.drill}: alice buys`),
      { order: orderPda(cross, alice.publicKey, 0).toBase58(), quoteAtoms: buy.toString() });
    step(run, `bob sells ${DRILLS[d.drill].sellNvdax} NVDAx`,
      await send([bob], [placeOrderIx(ref, { owner: bob.publicKey, day: b.day, kind: b.kind, nonce: 0, side: 'sell', amount: sell })], `${d.drill}: bob sells`),
      { order: orderPda(cross, bob.publicKey, 0).toBase58(), rawAtoms: sell.toString() });
    if (d.drill === 'pause') {
      step(run, 'the issuer pauses the mint',
        await send([operator], [createPauseInstruction(ref.mint, operator.publicKey, [], TOKEN_2022_PROGRAM_ID)], 'pause the drill mint'));
    } else {
      const effective = BigInt(b.ts + AFTER_BELL);
      step(run, `the issuer schedules multiplier ${DRILL_MULTIPLIER} for ${new Date(Number(effective) * 1000).toISOString()}, ${AFTER_BELL}s after the bell`,
        await send([operator], [createUpdateMultiplierDataInstruction(ref.mint, operator.publicKey, DRILL_MULTIPLIER, effective, [], TOKEN_2022_PROGRAM_ID)], 'schedule a new multiplier'));
    }
    doc.runs.push(run);
    writeDoc(doc);
  }
}

/* ── watch ──────────────────────────────────────────────────────────────── */

const CROSS_CANCELLED = [...createHash('sha256').update('event:CrossCancelled').digest().subarray(0, 8)];
const REASON: Record<number, string> = {
  1: 'print missing', 2: 'multiplier activation near the bell', 3: 'bad multiplier', 4: 'Pyth .RR disagrees', 5: 'unpriceable', 6: 'no print in time',
};

async function tokenBalance(account: string): Promise<bigint> {
  return conn.getTokenAccountBalance(new PublicKey(account)).then((r) => BigInt(r.value.amount)).catch(() => -1n);
}

/** Why a cross was cancelled, from the CrossCancelled event session-cross wrote. */
async function cancelReason(cross: PublicKey): Promise<{ reason: string; signature: string } | null> {
  const id = CROSS_PROGRAM_ID.toBase58();
  for (const s of await conn.getSignaturesForAddress(cross, { limit: 50 })) {
    if (s.err) continue;
    const tx = await conn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    const stack: string[] = [];
    for (const l of tx?.meta?.logMessages ?? []) {
      const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(l);
      if (invoke) { stack.push(invoke[1]); continue; }
      if (/^Program \w+ (success|failed)/.test(l)) { stack.pop(); continue; }
      const data = /^Program data: (\S+)$/.exec(l)?.[1];
      if (!data || stack[stack.length - 1] !== id) continue;
      const b = Buffer.from(data, 'base64');
      if (b.length === 8 + 32 + 1 && CROSS_CANCELLED.every((x, i) => b[i] === x) && new PublicKey(b.subarray(8, 40)).equals(cross)) {
        return { reason: REASON[b[40]] ?? `code ${b[40]}`, signature: s.signature };
      }
    }
  }
  return null;
}

async function ordersOf(cross: PublicKey) {
  const accts = await conn.getProgramAccounts(CROSS_PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(CROSS_ACCOUNT.Order)) } }, { memcmp: { offset: OFFSETS.orderCross, bytes: cross.toBase58() } }],
  });
  return accts.map((a) => ({ address: a.pubkey.toBase58(), o: decodeOrder(a.account.data) }));
}

const escrows = async (d: DrillManifest) => ({ quote: await tokenBalance(d.quoteEscrow), raw: await tokenBalance(d.rawEscrow) });

/** One look at a pause run. True once it has a result, either way. */
async function watchPause(d: DrillManifest, run: Run, operator: Keypair): Promise<boolean> {
  const cross = new PublicKey(run.cross);
  const has = (what: string) => run.steps.some((s) => s.what.startsWith(what));
  const info = await conn.getAccountInfo(cross);
  if (!info) {
    if (!has('cleared while paused')) return false; // closed before we saw it clear: keep looking, and say so at the deadline
    step(run, 'the keeper closed the cross');
    const e = await escrows(d);
    step(run, `escrow after close: ${e.quote} quote atoms, ${e.raw} raw atoms`, undefined, { quoteEscrow: e.quote.toString(), rawEscrow: e.raw.toString() });
    const ok = e.quote === 0n && e.raw === 0n && has('quote legs paid while paused') && has('the issuer resumes') && has('every order settled');
    run.result = ok ? 'passed' : 'failed';
    if (!ok) run.why = 'an escrow is not empty, or a step is missing';
    return true;
  }
  const c = decodeCross(info.data);
  if (c.phase === 'cancelled') {
    run.result = 'failed';
    run.why = `the cross was cancelled (${(await cancelReason(cross))?.reason ?? 'unknown'}), so the pause was never tested`;
    return true;
  }
  if (c.phase !== 'settling') return false;
  if (!has('cleared while paused')) {
    step(run, 'cleared while paused', undefined, {
      price: `${c.priceMantissa}e${c.priceExpo}`, crowded: c.clearing.crowded,
      buyTokens: c.clearing.buyTokens.toString(), sellQuote: c.clearing.sellQuote.toString(),
    });
  }
  const orders = await ordersOf(cross);
  const allQuote = orders.length === c.nOrders && orders.every((x) => (x.o.legs & LEG_QUOTE) !== 0);
  const tokensHeld = orders.some((x) => (x.o.legs & LEG_RAW) === 0);
  if (!has('quote legs paid while paused') && allQuote && tokensHeld) {
    const e = await escrows(d);
    step(run, 'quote legs paid while paused; the tokens are held', undefined, {
      orders: orders.map((x) => ({ order: x.address, side: x.o.side, legs: x.o.legs })),
      quoteEscrow: e.quote.toString(), rawEscrow: e.raw.toString(), quoteOut: c.quoteOut.toString(), rawOut: c.rawOut.toString(),
    });
  }
  if (has('quote legs paid while paused') && !has('the issuer resumes')) {
    step(run, 'the issuer resumes the mint',
      await send([operator], [createResumeInstruction(new PublicKey(d.mint), operator.publicKey, [], TOKEN_2022_PROGRAM_ID)], 'resume the drill mint'));
  }
  if (c.nSettled === c.nOrders && !has('every order settled')) {
    step(run, 'every order settled', undefined, { quoteIn: c.quoteIn.toString(), quoteOut: c.quoteOut.toString(), rawIn: c.rawIn.toString(), rawOut: c.rawOut.toString() });
  }
  return false;
}

async function watchMultiplier(d: DrillManifest, run: Run): Promise<boolean> {
  const cross = new PublicKey(run.cross);
  const has = (what: string) => run.steps.some((s) => s.what.startsWith(what));
  const info = await conn.getAccountInfo(cross);
  const c = info ? decodeCross(info.data) : null;
  if (!c && !has('the cross was cancelled')) return false;
  if (c && c.phase !== 'cancelled') {
    if (c.phase !== 'collecting') {
      run.result = 'failed';
      run.why = `the cross was priced (${c.phase}) despite the new multiplier`;
      return true;
    }
    return false;
  }
  if (!has('the cross was cancelled')) {
    const why = await cancelReason(cross).catch(() => null);
    step(run, `the cross was cancelled: ${why?.reason ?? 'reason not read'}`, why?.signature);
  }
  if (c && c.nSettled < c.nOrders) return false;
  if (!has('every order refunded')) {
    step(run, 'every order refunded whole', undefined,
      c ? { quoteIn: c.quoteIn.toString(), quoteOut: c.quoteOut.toString(), rawIn: c.rawIn.toString(), rawOut: c.rawOut.toString() } : undefined);
  }
  const e = await escrows(d);
  step(run, `escrow: ${e.quote} quote atoms, ${e.raw} raw atoms`, undefined, { quoteEscrow: e.quote.toString(), rawEscrow: e.raw.toString() });
  const whole = !c || (c.quoteOut === c.quoteIn && c.rawOut === c.rawIn);
  const ok = e.quote === 0n && e.raw === 0n && whole && run.steps.some((s) => /multiplier activation near the bell/.test(s.what));
  run.result = ok ? 'passed' : 'failed';
  if (!ok) run.why = 'an escrow is not empty, a refund was short, or the cancel was for another reason';
  return true;
}

async function watch(): Promise<void> {
  const operator = load(`${DIR}/operator.json`);
  const deadline = Date.now() + Number(process.env.DRILL_WATCH_HOURS ?? 14) * 3_600_000;
  while (Date.now() < deadline) {
    const doc = readDoc();
    if (!doc) throw new Error(`${OUT} is missing`);
    const open = doc.runs.filter((r) => !r.result);
    if (!open.length) { log('every drill has a result'); break; }
    for (const run of open) {
      if (Date.now() < Date.parse(run.bell)) continue;
      const d = doc.drills.find((x) => x.drill === run.drill)!;
      try {
        const done = run.drill === 'pause' ? await watchPause(d, run, operator) : await watchMultiplier(d, run);
        if (done) log(`${run.drill} drill ${run.result}${run.why ? `: ${run.why}` : ''}`);
      } catch (e) {
        log(`${run.drill}: ${String(e).slice(0, 160)}`);
      }
    }
    writeDoc(doc);
    // until the first bell, sleep in slices; after it, look every 20 s
    const first = Math.min(...open.map((r) => Date.parse(r.bell)));
    await sleep(Date.now() < first ? Math.min(first - Date.now(), 600_000) : 20_000);
  }
}

async function status(): Promise<void> {
  const doc = readDoc();
  if (!doc) { console.log(`${OUT} is missing: run --setup`); return; }
  for (const run of doc.runs) {
    console.log(`${run.drill.padEnd(10)} ${run.kind} of ${run.bell}  cross ${run.cross}  ${run.result ?? 'pending'}${run.why ? `: ${run.why}` : ''}`);
    for (const s of run.steps) console.log(`  ${s.at.slice(11, 19)}  ${s.what}${s.signature ? `  ${s.signature.slice(0, 16)}…` : ''}`);
  }
}

const main = args.includes('--setup') ? setup : args.includes('--arm') ? arm : args.includes('--watch') ? watch : status;
main().then(() => process.exit(0), (e) => {
  console.error(e);
  process.exit(1);
});
