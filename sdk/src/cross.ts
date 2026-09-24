/* ───────────────────────────────────────────────────────────────────────────
   The cross, in TypeScript: what an order at the bell will get.

   A line-for-line mirror of crates/session-core/src/xstock.rs and cross.rs,
   so a ticket can show what the program will do and a receipt can show what
   it did. BigInt makes the 256-bit intermediate exact for free. The Rust
   writes tests/vectors/cross.json, 300 crosses with every leg, and
   tests/cross.test.ts holds this file to it. docs/CROSS.md is the
   specification.
   ─────────────────────────────────────────────────────────────────────────── */

export const WAD = 10n ** 18n;
export const BPS = 10_000n;
export const MAX_FEE_BPS = 100;
export const LADDER = MAX_FEE_BPS + 1;

const floorDiv = (a: bigint, b: bigint, d: bigint) => (a * b) / d;
const ceilDiv = (a: bigint, b: bigint, d: bigint) => (a * b + d - 1n) / d;

/* ── what a raw atom is worth (xstock.rs) ────────────────────────────────── */

/** The WAD value of the f64 whose bits Token-2022 stores, rounded down; null
 *  for anything that cannot be a multiplier. */
export function multiplierWad(bits: bigint): bigint | null {
  if (bits >> 63n) return null;
  const exp = Number((bits >> 52n) & 0x7ffn);
  if (exp === 0 || exp === 0x7ff) return null;
  if (exp - 1023 < -20 || exp - 1023 > 20) return null;
  const mantissa = (bits & ((1n << 52n) - 1n)) | (1n << 52n);
  return (mantissa * WAD) >> BigInt(1075 - exp);
}

/** Token-2022's rule: the scheduled multiplier once its time has come. */
export const multiplierBitsAt = (current: bigint, next: bigint, nextEffectiveTs: number, t: number): bigint =>
  t >= nextEffectiveTs ? next : current;

/** Quote atoms per raw atom, WAD, rounded down, from a Pyth share price. */
export function pricePerRawWad(mantissa: bigint, expo: number, multiplier: bigint, quoteDecimals: number, rawDecimals: number): bigint | null {
  if (mantissa <= 0n || multiplier === 0n) return null;
  const k = expo + quoteDecimals - rawDecimals;
  const x = k >= 0 ? mantissa * 10n ** BigInt(k) * multiplier : (mantissa * multiplier) / 10n ** BigInt(-k);
  return x === 0n ? null : x;
}

/** A share price in 10⁻⁸ USD, the unit an order's limit is written in. */
export function priceE8(mantissa: bigint, expo: number): bigint | null {
  if (mantissa <= 0n) return null;
  const k = expo + 8;
  return k >= 0 ? mantissa * 10n ** BigInt(k) : mantissa / 10n ** BigInt(-k);
}

export interface ScaledUi { currentBits: bigint; newBits: bigint; newEffectiveTs: number }

/** The Scaled UI Amount configuration from a Token-2022 mint's bytes: null
 *  when the mint has none (a multiplier of one), 'malformed' for bytes that
 *  are not a well-formed mint. */
export function readScaledUi(data: Uint8Array): ScaledUi | null | 'malformed' {
  if (data.length <= 166) return data.length >= 82 ? null : 'malformed';
  if (data[165] !== 1) return 'malformed';
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 166;
  while (at + 4 <= data.length) {
    const ty = dv.getUint16(at, true);
    const len = dv.getUint16(at + 2, true);
    if (ty === 0 && len === 0) break;
    const body = at + 4;
    if (body + len > data.length) return 'malformed';
    if (ty === 25) {
      if (len !== 56) return 'malformed';
      return {
        currentBits: dv.getBigUint64(body + 32, true),
        newEffectiveTs: Number(dv.getBigInt64(body + 40, true)),
        newBits: dv.getBigUint64(body + 48, true),
      };
    }
    at = body + len;
  }
  return null;
}

/* ── the clearing (cross.rs) ─────────────────────────────────────────────── */

export type Crowded = 'balanced' | 'buyers' | 'sellers';

export interface Clearing {
  crowded: Crowded;
  priceWad: bigint;
  feeBps: number;
  makerPriceWad: bigint;
  marginalFeeBps: number;
  marginalNeed: bigint;
  marginalCap: bigint;
  buyIn: bigint;
  buySpent: bigint;
  buyTokens: bigint;
  sellIn: bigint;
  sellSpent: bigint;
  sellQuote: bigint;
}

function makerPrice(x: bigint, fee: number, crowded: Crowded): bigint {
  if (crowded === 'buyers') return floorDiv(x, BPS + BigInt(fee), BPS);
  if (crowded === 'sellers') return ceilDiv(x, BPS - BigInt(fee), BPS);
  return x;
}

/** The lowest fee somebody asked at which the offers asking at most it meet
 *  what is needed at it; null if even the highest ask falls short. */
function findFee(ladder: bigint[], need: (k: number) => bigint): [number, bigint] | null {
  if (need(0) === 0n) return [0, 0n];
  let cum = 0n;
  for (let k = 0; k < LADDER; k++) {
    if (ladder[k] === 0n) continue;
    cum += ladder[k];
    const n = need(k);
    if (cum >= n) return [k, n];
  }
  return null;
}

function marginal(ladder: bigint[], need: bigint): [number, bigint, bigint] {
  let below = 0n;
  for (let m = 0; m < LADDER; m++) {
    if (below + ladder[m] >= need) return [m, need - below, ladder[m]];
    below += ladder[m];
  }
  return [MAX_FEE_BPS, 0n, 0n];
}

const topFee = (ladder: bigint[]) => {
  for (let k = LADDER - 1; k >= 0; k--) if (ladder[k] > 0n) return k;
  return 0;
};

/** `ladder[f]`: total offered at exactly f bp, on the crowded side. */
export function emptyLadder(): bigint[] {
  return Array.from({ length: LADDER }, () => 0n);
}

export function clear(x: bigint, buyIn: bigint, sellIn: bigint, ladder: bigint[]): Clearing {
  if (x <= 0n) throw new Error('price must be positive');
  if (ladder.length !== LADDER) throw new Error(`a ladder has ${LADDER} buckets`);
  const base = { priceWad: x, buyIn, sellIn };
  const bWad = buyIn * WAD;
  const sxWad = sellIn * x;
  const total = ladder.reduce((a, c) => a + c, 0n);

  if (bWad === sxWad) {
    return {
      ...base, crowded: 'balanced', feeBps: 0, makerPriceWad: x, marginalFeeBps: 0, marginalNeed: 0n, marginalCap: 0n,
      buySpent: buyIn, buyTokens: sellIn, sellSpent: sellIn, sellQuote: buyIn,
    };
  }

  if (bWad > sxWad) {
    const r = bWad - sxWad;
    const found = findFee(ladder, (k) => r / makerPrice(x, k, 'buyers'));
    const [fee, supplied] = found ?? [topFee(ladder), total];
    const price = makerPrice(x, fee, 'buyers');
    const [m, needM, capM] = marginal(ladder, supplied);
    const spentWad = sxWad + supplied * price;
    return {
      ...base, crowded: 'buyers', feeBps: fee, makerPriceWad: price,
      marginalFeeBps: m, marginalNeed: needM, marginalCap: capM,
      buySpent: (spentWad + WAD - 1n) / WAD, buyTokens: sellIn + supplied,
      sellSpent: sellIn, sellQuote: sxWad / WAD,
    };
  }

  const excess = sxWad - bWad;
  const found = findFee(ladder, (k) => floorDiv(excess, BPS - BigInt(k), BPS * WAD));
  const [fee, paid] = found ?? [topFee(ladder), total];
  const price = makerPrice(x, fee, 'sellers');
  const [m, needM, capM] = marginal(ladder, paid);
  const a = ceilDiv(buyIn, WAD, x);
  const b = ceilDiv(paid, WAD, price);
  const spent = a + b < sellIn ? a + b : sellIn;
  return {
    ...base, crowded: 'sellers', feeBps: fee, makerPriceWad: price,
    marginalFeeBps: m, marginalNeed: needM, marginalCap: capM,
    buySpent: buyIn, buyTokens: floorDiv(buyIn, WAD, x),
    sellSpent: spent, sellQuote: buyIn + paid,
  };
}

/** An in-band buyer who escrowed `b` quote: [quote given up, raw atoms received]. */
export function buyerLeg(b: bigint, c: Clearing): [bigint, bigint] {
  if (c.buyIn === 0n) return [0n, 0n];
  return [ceilDiv(b, c.buySpent, c.buyIn), floorDiv(b, c.buyTokens, c.buyIn)];
}

/** An in-band seller who escrowed `s` raw atoms: [raw atoms given up, quote received]. */
export function sellerLeg(s: bigint, c: Clearing): [bigint, bigint] {
  if (c.sellIn === 0n) return [0n, 0n];
  return [ceilDiv(s, c.sellSpent, c.sellIn), floorDiv(s, c.sellQuote, c.sellIn)];
}

/** A maker's offer of `size` at `feeBps`: [given up, received]. */
export function makerLeg(size: bigint, feeBps: number, c: Clearing): [bigint, bigint] {
  if (c.crowded === 'balanced' || feeBps > c.marginalFeeBps || size === 0n) return [0n, 0n];
  let filled: bigint;
  let given: bigint;
  if (feeBps < c.marginalFeeBps) [filled, given] = [size, size];
  else if (c.marginalCap === 0n) [filled, given] = [0n, 0n];
  else [filled, given] = [floorDiv(size, c.marginalNeed, c.marginalCap), ceilDiv(size, c.marginalNeed, c.marginalCap)];
  const received = c.crowded === 'buyers' ? floorDiv(filled, c.makerPriceWad, WAD) : floorDiv(filled, WAD, c.makerPriceWad);
  return [given, received];
}

/** What a buyer paid per share, all in, for a receipt: quote per displayed
 *  token, given the raw atoms received and the multiplier. */
export function effectiveSharePrice(quoteSpent: bigint, rawReceived: bigint, multiplier: bigint, quoteDecimals: number, rawDecimals: number): number | null {
  if (rawReceived === 0n) return null;
  // displayed tokens = raw × multiplier / 10^rawDecimals; price = quote / displayed
  const displayedWad = (rawReceived * multiplier) / 10n ** BigInt(rawDecimals);
  return Number((quoteSpent * WAD * 1_000_000n) / (displayedWad * 10n ** BigInt(quoteDecimals))) / 1_000_000;
}
