/* ───────────────────────────────────────────────────────────────────────────
   Switching out of a weaker wrapper, and into the one a vault actually holds.

   Two tokens can track the same company and be very different claims: one
   whose issuer can move your balance, one whose issuer cannot; one that costs
   1% to transfer, one that costs nothing. `claim.ts` grades them. This is the
   other half — if the grade you hold is worse than the grade the vault holds,
   there is a route between them, and the vault can only be entered in its own
   underlying anyway.

   **Quote only.** Nothing here signs, and nothing here builds a transaction.
   Executing a swap is a different job with different failure modes (slippage
   the user agreed to, a route that changed between quote and send, a wallet
   that must approve two things in order), and it belongs with the retail
   surface that is gated on a live mainnet vault. What this gives a page is a
   number honest enough to decide with.

   `claim.ts` stays pure; this is where the network lives.
   ─────────────────────────────────────────────────────────────────────────── */

import type { Claim, Grade } from './claim.ts';

const JUP = 'https://lite-api.jup.ag/swap/v1/quote';

const RANK: Record<Grade, number> = { A: 0, B: 1, C: 2, D: 3, F: 4 };

export interface SwitchQuote {
  /** What the route would give, in the destination's atoms. */
  outAmount: bigint;
  /** Jupiter's own estimate, as a fraction: 0.0032 is 32 bp. */
  priceImpact: number;
  /** How many venues the route touches. One is not better, it is just shorter. */
  hops: number;
  /** The venues, so a reader can see what they are trusting. */
  route: string[];
}

export type SwitchResult =
  | { status: 'better'; quote: SwitchQuote; from: Grade; to: Grade }
  /** A route exists, but the wrapper held is not worse than the vault's. */
  | { status: 'no-gain'; quote: SwitchQuote; from: Grade; to: Grade }
  | { status: 'same-mint' }
  /** No route on this cluster. On devnet this is the normal answer. */
  | { status: 'no-route'; reason: string };

/**
 * Whether moving from one wrapper to another is an improvement in the claim.
 *
 * Strictly worse only — an equal grade is not a reason to pay a spread, and
 * this refusing to recommend a sideways move is the whole difference between
 * a grade and a funnel.
 */
export const isUpgrade = (from: Grade, to: Grade): boolean => RANK[from] > RANK[to];

/**
 * Price the switch. Returns what the route would do, never does it.
 *
 * `amount` is in the source mint's atoms. `slippageBps` only shapes the quote
 * Jupiter returns; nothing here commits to it.
 */
export async function switchPath(
  from: { mint: string; claim: Claim },
  to: { mint: string; claim: Claim },
  amount: bigint,
  opts: { slippageBps?: number; fetchImpl?: typeof fetch } = {},
): Promise<SwitchResult> {
  if (from.mint === to.mint) return { status: 'same-mint' };
  if (amount <= 0n) return { status: 'no-route', reason: 'nothing to switch' };

  const f = opts.fetchImpl ?? fetch;
  const url = `${JUP}?inputMint=${from.mint}&outputMint=${to.mint}&amount=${amount}` +
              `&slippageBps=${opts.slippageBps ?? 100}&onlyDirectRoutes=false`;

  let body: any;
  try {
    const r = await f(url);
    if (!r.ok) {
      return { status: 'no-route', reason: r.status === 404 ? 'no route between these mints' : `the router answered ${r.status}` };
    }
    body = await r.json();
  } catch (e) {
    return { status: 'no-route', reason: e instanceof Error ? e.message : String(e) };
  }

  if (!body?.outAmount) {
    // Devnet has no Jupiter liquidity for these mints, and saying "no route"
    // is the truth rather than a failure to be retried.
    return { status: 'no-route', reason: 'the router returned no route' };
  }

  const plan: any[] = body.routePlan ?? [];
  const quote: SwitchQuote = {
    outAmount: BigInt(body.outAmount),
    priceImpact: Number(body.priceImpactPct ?? 0),
    hops: plan.length,
    route: plan.map(p => String(p?.swapInfo?.label ?? 'unknown')),
  };

  return isUpgrade(from.claim.grade, to.claim.grade)
    ? { status: 'better', quote, from: from.claim.grade, to: to.claim.grade }
    : { status: 'no-gain', quote, from: from.claim.grade, to: to.claim.grade };
}
