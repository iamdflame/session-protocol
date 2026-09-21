/* ───────────────────────────────────────────────────────────────────────────
   The pools that make DAY true.

   The README claims DAY is always exitable. Without a secondary market that
   is false: mint and redeem work only while a class is *parked*, so for the
   6.5 hours DAY is exposed its holder is stuck unless somebody will buy it.
   A pool is what turns the claim into a fact.

   Three of them, on Meteora's DAMM v2:

     X.DAY/quote     sell DAY while it is exposed
     X.NIGHT/quote   sell NIGHT while it is exposed
     X.NIGHT/X.DAY   the implied overnight — the price of the night in units
                     of the day, which is a number that has not existed before

   The fee is where the session shows up. Neither DBC nor DAMM v2 has a
   wall-clock schedule, so "session-aware" cannot mean "a different fee after
   16:00" — claiming it would be a lie. What DAMM v2 does have is a dynamic
   fee that rises with realised volatility, and the night is where the
   volatility is: 2.78% against 1.90%, 46% wider, measured over 305 sessions.
   So the pool charges more at night because the night *is* more expensive,
   arrived at by the market rather than by a clock this program set.

     npm run pools            list what exists
     npm run pools -- --create
   ─────────────────────────────────────────────────────────────────────────── */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  CpAmm, getSqrtPriceFromPrice, getBaseFeeParams, getDynamicFeeParams, BaseFeeMode,
  MIN_SQRT_PRICE, MAX_SQRT_PRICE, deriveCustomizablePoolAddress, getPriceFromSqrtPrice,
} from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { ata, createAtaIdempotentIx, mintSharesIx } from '../../sdk/src/ix.ts';
import { decodeVault } from '../../sdk/src/vault.ts';
import type { Manifest } from './crank-core.ts';

const MANIFEST = 'keeper/.devnet/manifest.json';
const m: Manifest & { symbol: string; vaultSymbol?: string; pools?: Record<string, string> } =
  JSON.parse(readFileSync(MANIFEST, 'utf8'));
const op = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('keeper/.devnet/operator.json', 'utf8'))));
const conn = new Connection(m.rpc, 'confirmed');
const pk = (s: string) => new PublicKey(s);
const CREATE = process.argv.includes('--create');

/** 30 bp base, plus the volatility-responsive fee. */
const FEES = () => ({
  baseFee: getBaseFeeParams({
    baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear,
    feeTimeSchedulerParam: { startingFeeBps: 30, endingFeeBps: 30, numberOfPeriod: 0, totalDuration: 0 },
  }),
  compoundingFeeBps: 0,
  padding: 0,
  dynamicFee: getDynamicFeeParams(30),
});

const SHARE_PROGRAM = pk(m.shareTokenProgram);
const QUOTE_PROGRAM = pk(m.tokenProgram);

interface PoolSpec {
  name: string;
  a: PublicKey;
  aProgram: PublicKey;
  aDecimals: number;
  b: PublicKey;
  bProgram: PublicKey;
  bDecimals: number;
  /** Price of one A in units of B. */
  price: string;
}

const v = decodeVault((await conn.getAccountInfo(pk(m.vault)))!.data);
const qd = v.quoteDecimals;
const sym = m.vaultSymbol ?? m.symbol;
const navNight = Number(v.nightNav) / 1e18;
const navDay = Number(v.dayNav) / 1e18;

const SPECS: PoolSpec[] = [
  {
    name: `${sym}.DAY/quote`,
    a: pk(m.dayMint), aProgram: SHARE_PROGRAM, aDecimals: qd,
    b: pk(m.quoteMint), bProgram: QUOTE_PROGRAM, bDecimals: qd,
    price: navDay.toString(),
  },
  {
    name: `${sym}.NIGHT/quote`,
    a: pk(m.nightMint), aProgram: SHARE_PROGRAM, aDecimals: qd,
    b: pk(m.quoteMint), bProgram: QUOTE_PROGRAM, bDecimals: qd,
    price: navNight.toString(),
  },
  {
    // The implied overnight. A price above 1.0 means the market pays more for
    // the night than for the day — which the study says it should not, and
    // which is exactly the disagreement worth publishing.
    name: `${sym}.NIGHT/${sym}.DAY`,
    a: pk(m.nightMint), aProgram: SHARE_PROGRAM, aDecimals: qd,
    b: pk(m.dayMint), bProgram: SHARE_PROGRAM, bDecimals: qd,
    price: (navNight / navDay).toString(),
  },
];

const cpAmm = new CpAmm(conn);

/* ── what exists ─────────────────────────────────────────────────────────── */

const balance = async (mint: PublicKey, program: PublicKey) =>
  conn.getTokenAccountBalance(ata(op.publicKey, mint, program))
    .then(r => BigInt(r.value.amount)).catch(() => 0n);

console.log(`vault   ${m.vault}`);
console.log(`exposed ${v.exposed}  —  a class can only be minted while it is parked`);
const held = {
  quote: await balance(pk(m.quoteMint), QUOTE_PROGRAM),
  night: await balance(pk(m.nightMint), SHARE_PROGRAM),
  day: await balance(pk(m.dayMint), SHARE_PROGRAM),
};
console.log(`operator holds  quote ${held.quote / 10n ** BigInt(qd)}  night ${held.night / 10n ** BigInt(qd)}  day ${held.day / 10n ** BigInt(qd)}`);
console.log();

const existing: Record<string, string> = { ...(m.pools ?? {}) };
for (const s of SPECS) {
  const addr = deriveCustomizablePoolAddress(s.a, s.b);
  const info = await conn.getAccountInfo(addr);
  console.log(`  ${info ? 'live ' : '—    '} ${s.name.padEnd(24)} ${addr.toBase58()}${info ? '' : '  (not created)'}`);
  if (info) existing[s.name] = addr.toBase58();
}

if (!CREATE) {
  console.log('\npass --create to open the missing ones');
  process.exit(0);
}

/* ── seed the operator with shares to put in ─────────────────────────────── */

const SEED = 2_000n * 10n ** BigInt(qd);
const parked = v.exposed === 'night' ? 'day' : 'night';
const parkedMint = parked === 'night' ? pk(m.nightMint) : pk(m.dayMint);

// The parked class seeds two pools — its own quote pair and the NIGHT/DAY
// pair — so mint for both, plus a little to trade with. Minting only enough
// for the first leaves nothing for the second and the run half-finishes.
const NEED_PARKED = SEED * 2n + SEED / 4n;

if ((parked === 'night' ? held.night : held.day) < NEED_PARKED) {
  console.log(`\nminting ${NEED_PARKED / 10n ** BigInt(qd)} ${sym}.${parked.toUpperCase()} — two pools use it, plus a little to trade with…`);
  const need = NEED_PARKED - (parked === 'night' ? held.night : held.day);
  const tx = new Transaction().add(
    createAtaIdempotentIx(op.publicKey, op.publicKey, parkedMint, SHARE_PROGRAM),
    mintSharesIx({
      vault: pk(m.vault), classMint: parkedMint,
      nightMint: pk(m.nightMint), dayMint: pk(m.dayMint), quoteVault: pk(m.quoteVault),
      userQuote: ata(op.publicKey, pk(m.quoteMint), QUOTE_PROGRAM),
      userShares: ata(op.publicKey, parkedMint, SHARE_PROGRAM),
      user: op.publicKey, quoteMint: pk(m.quoteMint),
      tokenProgram: QUOTE_PROGRAM, shareTokenProgram: SHARE_PROGRAM,
    }, parked, need),
  );
  const sig = await sendAndConfirmTransaction(conn, tx, [op], { commitment: 'confirmed' });
  console.log(`  ${sig}`);
  held[parked] = await balance(parkedMint, SHARE_PROGRAM);
}

/* ── open the pools that can be opened ───────────────────────────────────── */

for (const s of SPECS) {
  const addr = deriveCustomizablePoolAddress(s.a, s.b);
  if (await conn.getAccountInfo(addr)) continue;

  const aHeld = await balance(s.a, s.aProgram);
  const bHeld = await balance(s.b, s.bProgram);
  const priceNum = Number(s.price);
  // Both sides in proportion to the price, or the implied liquidity asks for
  // more of one than exists.
  const aAmount = SEED < aHeld ? SEED : aHeld;
  const bAmount = BigInt(Math.floor(Number(aAmount) * priceNum));
  if (aAmount === 0n || bAmount === 0n || bHeld < bAmount) {
    console.log(`\n  skip ${s.name}: holds ${aHeld} of A and ${bHeld} of B, needs ${aAmount}/${bAmount}`);
    console.log(`       ${s.name.includes(v.exposed.toUpperCase()) ? `${v.exposed.toUpperCase()} is exposed and cannot be minted until the next bell` : 'seed it after the next bell'}`);
    continue;
  }

  const initSqrtPrice = getSqrtPriceFromPrice(s.price, s.aDecimals, s.bDecimals);
  const tokenAAmount = new BN(aAmount.toString());
  const tokenBAmount = new BN(bAmount.toString());
  const { liquidityDelta } = cpAmm.preparePoolCreationParams({
    tokenAAmount, tokenBAmount, minSqrtPrice: MIN_SQRT_PRICE, maxSqrtPrice: MAX_SQRT_PRICE, initSqrtPrice,
  });
  const positionNft = Keypair.generate();
  const { tx, pool } = await cpAmm.createCustomPool({
    payer: op.publicKey, creator: op.publicKey, positionNft: positionNft.publicKey,
    tokenAMint: s.a, tokenBMint: s.b, tokenAAmount, tokenBAmount,
    sqrtMinPrice: MIN_SQRT_PRICE, sqrtMaxPrice: MAX_SQRT_PRICE, initSqrtPrice, liquidityDelta,
    poolFees: FEES(), hasAlphaVault: false, collectFeeMode: 0,
    activationPoint: null, activationType: 1,
    tokenAProgram: s.aProgram, tokenBProgram: s.bProgram, isLockLiquidity: false,
  });
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [op, positionNft], { commitment: 'confirmed' });
    console.log(`\n  opened ${s.name}  ${pool.toBase58()}`);
    console.log(`         seeded ${aAmount} / ${bAmount} at ${s.price}   ${sig}`);
    existing[s.name] = pool.toBase58();
  } catch (e: unknown) {
    const err = e as { logs?: string[]; message?: string };
    console.log(`\n  FAILED ${s.name}: ${err.message?.split('\n')[0]}`);
    for (const l of (err.logs ?? []).filter(l => /Error|failed/i.test(l)).slice(0, 5)) console.log('         ' + l);
  }
}

/* ── record them ─────────────────────────────────────────────────────────── */

if (Object.keys(existing).length) {
  const updated = { ...m, pools: existing };
  writeFileSync(MANIFEST, JSON.stringify(updated, null, 2));
  writeFileSync('web/public/devnet.json', JSON.stringify(updated, null, 2));
  console.log(`\nwrote ${Object.keys(existing).length} pool(s) to the manifest`);
}

/* ── prove it can actually be traded ─────────────────────────────────────── */

if (process.argv.includes('--swap')) {
  const name = `${sym}.${parked.toUpperCase()}/quote`;
  const pool = existing[name];
  if (!pool) {
    console.log(`\nno ${name} pool to swap through`);
  } else {
    const SELL = 10n * 10n ** BigInt(qd);
    const before = await balance(pk(m.quoteMint), QUOTE_PROGRAM);
    const state = await cpAmm.fetchPoolState(pk(pool));
    const slot = await conn.getSlot();
    const now = Math.floor(Date.now() / 1000);
    const quote = await cpAmm.getQuote({
      inAmount: new BN(SELL.toString()), inputTokenMint: parkedMint, slippage: 0.5,
      poolState: state, currentTime: now, currentSlot: slot,
    });
    const tx = await cpAmm.swap({
      payer: op.publicKey, pool: pk(pool), inputTokenMint: parkedMint,
      outputTokenMint: pk(m.quoteMint), amountIn: new BN(SELL.toString()),
      minimumAmountOut: quote.minSwapOutAmount, tokenAMint: state.tokenAMint,
      tokenBMint: state.tokenBMint, tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault,
      tokenAProgram: SHARE_PROGRAM, tokenBProgram: QUOTE_PROGRAM, referralTokenAccount: null,
    });
    const sig = await sendAndConfirmTransaction(conn, tx, [op], { commitment: 'confirmed' });
    const after = await balance(pk(m.quoteMint), QUOTE_PROGRAM);
    const got = after - before;
    console.log(`\nsold ${SELL / 10n ** BigInt(qd)} ${sym}.${parked.toUpperCase()} into the pool`);
    console.log(`  received ${Number(got) / 10 ** qd} quote  (${((Number(got) / Number(SELL) - 1) * 10_000).toFixed(0)} bp vs NAV, fee and impact)`);
    console.log(`  ${sig}`);
    console.log(got > 0n
      ? `  a holder can leave this class without waiting for it to park — which is what "always exitable" has to mean`
      : `  FAILED: nothing came back`);
  }
}

/* ── what the implied overnight says ─────────────────────────────────────── */

const implied = existing[`${sym}.NIGHT/${sym}.DAY`];
if (implied) {
  const state = await cpAmm.fetchPoolState(pk(implied));
  const price = getPriceFromSqrtPrice(state.sqrtPrice, qd, qd);
  console.log(`\nimplied overnight  ${Number(price).toFixed(6)} ${sym}.DAY per ${sym}.NIGHT`);
  console.log(`NAV ratio          ${(navNight / navDay).toFixed(6)}`);
}
