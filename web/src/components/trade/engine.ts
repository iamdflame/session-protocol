/* ───────────────────────────────────────────────────────────────────────────
   What a trade panel needs from whatever is behind it.

   Two things can be behind it: the real vault on devnet, where a mint is a
   signed transaction, and the simulation in this browser, where a mint is the
   same arithmetic applied to balances kept here. The panel draws one
   interface over both and never lets them be confused — `kind` is on every
   surface it renders — but it should not have to know which one it is to lay
   out an amount field.
   ─────────────────────────────────────────────────────────────────────────── */

import type { SourceKind } from '../ui/Source';
import type { TxStage } from '@/lib/chain';

export type Mode = 'mint' | 'redeem';
export type Cls = 'day' | 'night';

/** Why a preview is refused. `not-parked` is explained by the panel itself. */
export type Refusal = 'not-parked' | 'halted' | 'paused' | 'input';

export type Preview =
  | { ok: true; out: number; outText: string }
  | { ok: false; kind: Refusal; reason: string };

export type Outcome =
  | { ok: true; headline: string; detail: string; sig?: string }
  | { ok: false; error: string };

export interface TradeEngine {
  /** live = the vault on devnet; simulated = settle() in this browser; demo = the same, read-only framing. */
  kind: 'live' | 'simulated' | 'demo';
  /** The class tickers: NVDA.DAY, OPENAI.THEN. */
  names: Record<Cls, string>;
  /** The short words: DAY/NIGHT, or NOW/THEN on an event vault. */
  words: Record<Cls, string>;
  /** The class open to mint and redeem. */
  parked: Cls;
  /** The vault's halt reason, when it has stopped. */
  halted: string | null;
  nav: Record<Cls, number>;
  /** Spendable quote. Null where no wallet balance applies. */
  quoteBalance: number | null;
  /** Shares held of each class; null when unknown (no wallet). */
  held: Record<Cls, number | null>;
  preview(mode: Mode, cls: Cls, amount: number): Preview;
  execute(mode: Mode, cls: Cls, amount: number, onStage: (s: TxStage) => void): Promise<Outcome>;
  wallet: { needed: boolean; connected: boolean; connect: () => void };
  /** The price the vault is marking against, and where it comes from. */
  mark: { label: string; value: number | null; source: SourceKind; detail: string; ageSec: number | null; staleAfter?: number };
  /** What a trade costs, in words that are true for this engine. */
  fees(mode: Mode, cls: Cls): { network: string; protocol: string };
  faucet?: { run: () => Promise<Outcome> };
  /** When the class carrying the exposure is next back in quote, e.g. "09:30 ET"; null when no calendar applies. */
  reopens: string | null;
  /** Fixed quick amounts for minting where there is no balance to take a share of. */
  quickMint?: number[];
}
