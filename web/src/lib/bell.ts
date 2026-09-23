/* ───────────────────────────────────────────────────────────────────────────
   What the next bell will do, before it rings.

   Not an estimate built for the screen: this runs the SDK's `settle()` — the
   same arithmetic the program runs at the boundary — on the vault's current
   state and the live mark. The exposed class is rolled by the move since the
   last bell, funding is charged between the classes at their sizes now, and
   exposure flips. What comes back is what the bell would settle *if it rang
   at this mark*; the real one settles at the mark published at the bell, and
   every surface that shows this says so.
   ─────────────────────────────────────────────────────────────────────────── */

import { settle, DEFAULT_FUNDING, type NavState, type FundingParams } from '@sdk/settle.ts';
import { SESSION_EVENT } from '@sdk/vault.ts';
import type { ChainVault as ChainState } from './chain';
import type { LocalVault } from './localVault';

export type Cls = 'day' | 'night';

export interface BellPreview {
  navBefore: Record<Cls, number>;
  navAfter: Record<Cls, number>;
  /** Signed quote atoms → units: positive means NIGHT pays DAY. */
  funding: number;
  /** Who holds the stock once the bell has settled. */
  exposedAfter: Cls;
  /** The exposed class could not absorb the move; the vault would halt. */
  shortfall: boolean;
}

const WAD = 1e18;

function run(state: NavState, mark: bigint, p: FundingParams, decimals: number): BellPreview | null {
  if (state.lastMark === 0n || mark === 0n) return null;
  const r = settle(state, mark, p);
  return {
    navBefore: { day: Number(state.dayNav) / WAD, night: Number(state.nightNav) / WAD },
    navAfter: { day: Number(r.dayNav) / WAD, night: Number(r.nightNav) / WAD },
    funding: Number(r.funding) / 10 ** decimals,
    exposedAfter: r.exposed,
    shortfall: r.shortfall > 0n,
  };
}

/** An equity vault on chain, at its live mark. Null for an event vault, a halted one, or a missing mark. */
export function previewChainBell(d: ChainState): BellPreview | null {
  const v = d.vault;
  if (v.sessionKind === SESSION_EVENT || v.halted || d.markWad === null) return null;
  return run(
    {
      nightSupply: d.nightSupply, daySupply: d.daySupply, ownedUnderlying: v.ownedUnderlying,
      nightNav: v.nightNav, dayNav: v.dayNav, exposed: v.exposed, lastMark: v.lastMark,
    },
    d.markWad,
    { kBps: BigInt(v.fundingKBps), maxBps: BigInt(v.fundingMaxBps) },
    v.quoteDecimals,
  );
}

/** The simulation in this browser, at the mark it is being run against. */
export function previewLocalBell(v: LocalVault, mark: bigint): BellPreview | null {
  if (v.halted) return null;
  return run(
    {
      nightSupply: v.nightSupply, daySupply: v.daySupply, ownedUnderlying: v.ownedUnderlying,
      nightNav: v.nightNav, dayNav: v.dayNav, exposed: v.exposed, lastMark: v.lastMark,
    },
    mark, DEFAULT_FUNDING, 6,
  );
}

/** What a holding of `held` shares in each class becomes, in quote. */
export function holdingChange(p: BellPreview, held: Record<Cls, number>) {
  const before = held.day * p.navBefore.day + held.night * p.navBefore.night;
  const after = held.day * p.navAfter.day + held.night * p.navAfter.night;
  return { before, after, change: after - before };
}
