/* ───────────────────────────────────────────────────────────────────────────
   The counterfactual beside a cross: what a swap of the same size returned
   on Jupiter at the bell, for the real xStock on mainnet.

   A receipt that claims a saving without the alternative beside it is an
   advertisement. So the keeper that prices a cross quotes each side's total
   on Jupiter as the bell rings, and writes the quotes into a Memo
   instruction of the price_cross transaction itself: timestamped by the
   chain, signed by the keeper, in the cross's own history where any explorer
   shows it. `getSignaturesForAddress` returns each transaction's memo with
   its signature, so a receipt finds it without fetching anything else.

   Anyone can put a memo in a transaction that touches a cross. A receipt
   therefore shows a counterfactual only from the transaction that priced
   the cross, signed by the keeper the market's manifest names
   (`counterfactualFrom`).

   Only what Jupiter returned is recorded. A side with no orders has no
   quote; a side Jupiter could not route says so, with Jupiter's reason.
   ─────────────────────────────────────────────────────────────────────────── */

import { PublicKey, TransactionInstruction } from '@solana/web3.js';

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
/** Mainnet USDC: what the counterfactual swaps against. The devnet quote token stands in for it at the same 6 decimals. */
export const MAINNET_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const COUNTERFACTUAL_TAG = 'session-cross counterfactual v1 ';
/** A quote taken later than this after the bell is not the bell's alternative. */
export const COUNTERFACTUAL_WINDOW_SECS = 900;

/** One side's swap, in atoms: USDC in and raw xStock out for buyers, the reverse for sellers. */
export type SwapQuote =
  | { in: string; out: string; impactPct: number; route: string }
  | { noRoute: string };

export interface Counterfactual {
  /** The cross, base58. */
  cross: string;
  /** Unix seconds the quotes were taken. */
  at: number;
  venue: 'jupiter';
  /** The mainnet xStock quoted. */
  mint: string;
  /** USDC → xStock for the buyers' total. Absent when there were no buyers. */
  buy?: SwapQuote;
  /** xStock → USDC for the sellers' total, in raw atoms. Absent when there were no sellers. */
  sell?: SwapQuote;
}

export function encodeCounterfactual(c: Counterfactual): string {
  return COUNTERFACTUAL_TAG + JSON.stringify(c);
}

export function counterfactualMemoIx(c: Counterfactual): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: new TextEncoder().encode(encodeCounterfactual(c)) as Buffer,
  });
}

const DIGITS = /^\d{1,20}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function quote(v: unknown): SwapQuote | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v !== 'object' || v === null) return null;
  const q = v as Record<string, unknown>;
  if (typeof q.noRoute === 'string') return { noRoute: q.noRoute.slice(0, 120) };
  if (typeof q.in === 'string' && DIGITS.test(q.in) && typeof q.out === 'string' && DIGITS.test(q.out)
    && typeof q.impactPct === 'number' && Number.isFinite(q.impactPct) && typeof q.route === 'string') {
    return { in: q.in, out: q.out, impactPct: q.impactPct, route: q.route.slice(0, 120) };
  }
  return null;
}

/** The JSON object that starts at `from`, by brace depth outside strings. */
function objectAt(text: string, from: number): string | null {
  if (text[from] !== '{') return null;
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(from, i + 1);
  }
  return null;
}

/**
 * The counterfactual in a memo, or null. Accepts the memo text itself or the
 * RPC's `memo` field, which prefixes each memo with its length ("[312] …")
 * and joins several with "; ". Anything malformed is null, never a guess.
 */
export function readCounterfactual(memo: string | null | undefined): Counterfactual | null {
  if (!memo) return null;
  const at = memo.indexOf(COUNTERFACTUAL_TAG);
  if (at < 0) return null;
  const json = objectAt(memo, at + COUNTERFACTUAL_TAG.length);
  if (!json) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof v.cross !== 'string' || !B58.test(v.cross) || typeof v.mint !== 'string' || !B58.test(v.mint)) return null;
  if (typeof v.at !== 'number' || !Number.isInteger(v.at) || v.venue !== 'jupiter') return null;
  const buy = quote(v.buy);
  const sell = quote(v.sell);
  if (buy === null || sell === null) return null;
  const out: Counterfactual = { cross: v.cross, at: v.at, venue: 'jupiter', mint: v.mint };
  if (buy) out.buy = buy;
  if (sell) out.sell = sell;
  return out;
}

/**
 * How much more the cross gave per unit put in than the swap would have, in
 * basis points to two places; positive means the cross did better. Rates,
 * not totals: the cross may spend less than a side's total when limits fall
 * out of band, while the swap was quoted for all of it.
 */
export function edgeBps(crossIn: bigint, crossOut: bigint, swapIn: bigint, swapOut: bigint): number | null {
  if (crossIn <= 0n || swapIn <= 0n || swapOut <= 0n) return null;
  const ratio = (crossOut * swapIn * 1_000_000n) / (crossIn * swapOut); // 1,000,000 is parity
  return Number(ratio - 1_000_000n) / 100;
}
