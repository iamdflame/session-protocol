/* ───────────────────────────────────────────────────────────────────────────
   The demo sandbox: a copy of a real vault that a visitor can push around.

   Seeded from the vault account as it stands on devnet — supplies, NAVs, the
   inventory, which class is exposed, the last mark — and then run with the
   same code the simulation uses: the program's `settle()` and the mint and
   redeem rules mirrored from `ops.rs`. The visitor starts holding nothing.

   It is never written anywhere and never presented as the chain. The page
   that holds it labels every figure DEMO, and leaving the page throws it
   away. What it buys is the one thing a read-only page cannot show: what a
   position does when the bell rings, without anybody signing anything.
   ─────────────────────────────────────────────────────────────────────────── */

import type { ChainVault as ChainState } from './chain';
import type { LocalVault } from './localVault';

export function sandboxFromChain(d: ChainState, symbol: string): LocalVault {
  const v = d.vault;
  return {
    symbol,
    decimals: v.underlyingDecimals,
    nightSupply: d.nightSupply,
    daySupply: d.daySupply,
    nightNav: v.nightNav,
    dayNav: v.dayNav,
    ownedUnderlying: v.ownedUnderlying,
    ownedQuote: v.ownedQuote,
    pendingDelta: v.pendingDelta,
    exposed: v.exposed,
    lastMark: v.lastMark,
    lastBoundaryTs: v.lastBoundaryTs,
    myNight: 0n,
    myDay: 0n,
    halted: v.halted,
    haltReason: v.halted ? String(v.haltReason) : '',
    history: [],
  };
}
