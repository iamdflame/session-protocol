/* ───────────────────────────────────────────────────────────────────────────
   A vault, locally.

   The program is not deployed, so there is no account to read. Rather than
   draw a mock, this runs the *real* code: `settle`, `valueOf`, `skewWad`,
   `fundingTransfer` and `evaluate` are imported from the same SDK the program
   is pinned to, and the mint/redeem rules below mirror `ops.rs` — including
   the parked-class rule, the flooring direction on each side, and the reserved
   quote that an outstanding handoff makes unpayable.

   What is simulated is *custody*: the balances live in localStorage instead of
   in token accounts. Every number derived from them is computed the way the
   chain would compute it, which is why this can be shown without lying.
   ─────────────────────────────────────────────────────────────────────────── */

import {
  WAD, settle, valueOf, skewWad, mulDivFloor,
  DEFAULT_FUNDING, type ShareClass, type NavState,
} from '@sdk/settle.ts';
import { evaluate, Severity, type Health, type VaultState } from '@sdk/health.ts';
import { sessionAt, Session, nextBoundary } from '@sdk/calendar.ts';
import { normalizeMark } from '@sdk/vault.ts';

export { Severity };
export type { Health, ShareClass };

/**
 * Quote is USDC-shaped: six decimals. Shares carry the same six, so a NAV of
 * exactly `WAD` means one share is worth one unit of quote — which is where
 * both classes start, and what makes every NAV on screen readable as a ratio.
 */
export const QUOTE_DECIMALS = 6;
export const QUOTE_UNIT = 10n ** BigInt(QUOTE_DECIMALS);
export const SHARE_UNIT = QUOTE_UNIT;

export interface LocalVault {
  symbol: string;
  /** Underlying token decimals, from the asset metadata. */
  decimals: number;

  nightSupply: bigint;
  daySupply: bigint;
  nightNav: bigint;
  dayNav: bigint;
  ownedUnderlying: bigint;
  ownedQuote: bigint;
  pendingDelta: bigint;

  exposed: ShareClass;
  lastMark: bigint;
  lastBoundaryTs: number;

  /** What this browser holds, in shares. */
  myNight: bigint;
  myDay: bigint;

  halted: boolean;
  haltReason: string;

  /** Boundaries this vault has settled, for the activity list. */
  history: Event[];
}

export interface Event {
  ts: number;
  kind: 'settle' | 'mint' | 'redeem';
  cls?: ShareClass;
  /** Shares moved, for mint/redeem. */
  shares?: bigint;
  /** Quote moved, for mint/redeem. */
  quote?: bigint;
  /** NAVs after the event. */
  nightNav: bigint;
  dayNav: bigint;
  funding?: bigint;
  handoffDelta?: bigint;
}

export type OpError =
  | 'zero'
  | 'not-parked'
  | 'nav-collapsed'
  | 'too-small'
  | 'insufficient-free-quote'
  | 'insufficient-shares'
  | 'halted';

export const OP_MESSAGE: Record<OpError, string> = {
  zero: 'Enter an amount.',
  'not-parked': 'That class is holding the stock right now. It can only be minted or redeemed while it is flat — otherwise a deposit would land mid-session and dilute the return the existing holders already earned.',
  'nav-collapsed': 'This class has been written down to zero. There is nothing to mint against.',
  'too-small': 'Too small to round to a whole share at the current NAV.',
  'insufficient-free-quote': 'The vault has quote committed to an outstanding handoff. Redeeming it would leave the handoff unfillable.',
  'insufficient-shares': 'You do not hold that many shares.',
  halted: 'This vault is halted. Redemption is the only operation available.',
};

/* ── the mark ────────────────────────────────────────────────────────────── */

/**
 * A price, in the program's units.
 *
 * `last_mark` on chain is *quote atoms per underlying atom, WAD-scaled* — not
 * dollars, and not quote atoms per whole token. Every formula in `settle()`
 * assumes that: the NAV roll divides `owned_underlying × spread` by the share
 * supply, the re-hedge divides value by the mark to get atoms back. A mark in
 * the wrong unit does not throw; it settles a move of the wrong size by ten
 * orders of magnitude, silently.
 *
 * So the conversion is the SDK's own `normalizeMark`, fed the price as an
 * integer with an exponent the way Pyth publishes it. The first version of
 * this file had its own scaling and the settlement check caught it: the
 * exposed class earned nothing across a 10% day.
 */
export function markFromPrice(price: number, underlyingDecimals: number): bigint {
  if (!(price > 0)) return 0n;
  const EXPO = -8;
  return normalizeMark(
    {
      feedId: new Uint8Array(32),
      price: BigInt(Math.round(price * 1e8)),
      conf: 0n,
      expo: EXPO,
      publishTime: 0,
    },
    underlyingDecimals,
    QUOTE_DECIMALS,
  );
}

/* ── construction ────────────────────────────────────────────────────────── */

/**
 * A fresh vault at the asset's live price.
 *
 * Both NAVs start at one unit of quote per share, and the vault starts with
 * enough underlying to back the exposed class exactly — the state a real vault
 * reaches after its first balanced handoff.
 */
export function freshVault(symbol: string, decimals: number, price: number, now: number): LocalVault {
  const mark = markFromPrice(price, decimals);
  const open = sessionAt(now) === Session.Open;
  return {
    symbol,
    decimals,
    nightSupply: 0n,
    daySupply: 0n,
    nightNav: WAD,
    dayNav: WAD,
    ownedUnderlying: 0n,
    ownedQuote: 0n,
    pendingDelta: 0n,
    exposed: open ? 'day' : 'night',
    lastMark: mark > 0n ? mark : WAD,
    lastBoundaryTs: now,
    myNight: 0n,
    myDay: 0n,
    halted: false,
    haltReason: '',
    history: [],
  };
}

/* ── derived ─────────────────────────────────────────────────────────────── */

export interface Derived {
  valueNight: bigint;
  valueDay: bigint;
  skew: bigint;
  totalClaims: bigint;
  backing: bigint;
  margin: bigint;
  health: Health;
  nextBoundaryTs: number | null;
}

export function derive(v: LocalVault, mark: bigint, now: number): Derived {
  const valueNight = valueOf(v.nightSupply, v.nightNav);
  const valueDay = valueOf(v.daySupply, v.dayNav);
  const totalClaims = valueNight + valueDay;

  // What the vault is actually worth right now: inventory marked to the live
  // price, plus the quote it holds. Underlying atoms × (quote atoms per atom,
  // WAD-scaled) / WAD = quote atoms.
  const backing = mulDivFloor(v.ownedUnderlying, mark, WAD) + v.ownedQuote;

  const state: VaultState = {
    halted: v.halted,
    haltReason: v.haltReason,
    paused: 0,
    nightSupply: v.nightSupply,
    daySupply: v.daySupply,
    nightNav: v.nightNav,
    dayNav: v.dayNav,
    lastMark: v.lastMark,
    ownedUnderlying: v.ownedUnderlying,
    ownedQuote: v.ownedQuote,
    balanceUnderlying: v.ownedUnderlying,
    balanceQuote: v.ownedQuote,
    pendingDelta: v.pendingDelta,
    lastBoundaryTs: v.lastBoundaryTs,
    lastSessionOpen: v.exposed === 'day',
    maxCarryDeltaBps: 500,
    markPublishTs: now,
    equityPublishTs: now,
    maxStaleSecs: 120,
    equityQuietSecs: 6 * 3600,
    maxUnexpectedClosedSecs: 3 * 3600,
  };

  return {
    valueNight,
    valueDay,
    skew: skewWad(valueNight, valueDay),
    totalClaims,
    backing,
    margin: backing - totalClaims,
    health: evaluate(state, now),
    nextBoundaryTs: nextBoundary(now, 20),
  };
}

/* ── operations, mirroring ops.rs ────────────────────────────────────────── */

const isParked = (v: LocalVault, c: ShareClass) => v.exposed !== c;
const navOf = (v: LocalVault, c: ShareClass) => (c === 'night' ? v.nightNav : v.dayNav);
const reservedQuote = (v: LocalVault) => (v.pendingDelta > 0n ? v.pendingDelta : 0n);
const freeQuote = (v: LocalVault) => {
  const r = reservedQuote(v);
  return v.ownedQuote > r ? v.ownedQuote - r : 0n;
};

export type MintPlan = { ok: true; kind: 'mint'; shares: bigint } | { ok: false; err: OpError };
export type RedeemPlan = { ok: true; kind: 'redeem'; quote: bigint } | { ok: false; err: OpError };

export function planMint(v: LocalVault, c: ShareClass, quote: bigint): MintPlan {
  if (v.halted) return { ok: false, err: 'halted' };
  if (quote <= 0n) return { ok: false, err: 'zero' };
  if (!isParked(v, c)) return { ok: false, err: 'not-parked' };
  const nav = navOf(v, c);
  if (nav === 0n) return { ok: false, err: 'nav-collapsed' };
  // floor: a depositor can never mint more claim than the quote they brought
  const shares = mulDivFloor(quote, WAD, nav);
  if (shares === 0n) return { ok: false, err: 'too-small' };
  return { ok: true, kind: 'mint', shares };
}

export function planRedeem(v: LocalVault, c: ShareClass, shares: bigint): RedeemPlan {
  if (shares <= 0n) return { ok: false, err: 'zero' };
  if (!isParked(v, c)) return { ok: false, err: 'not-parked' };
  const held = c === 'night' ? v.myNight : v.myDay;
  if (shares > held) return { ok: false, err: 'insufficient-shares' };
  const nav = navOf(v, c);
  // floor: redemption can never take more than the claim
  const quote = mulDivFloor(shares, nav, WAD);
  if (quote === 0n) return { ok: false, err: 'too-small' };
  if (quote > freeQuote(v)) return { ok: false, err: 'insufficient-free-quote' };
  return { ok: true, kind: 'redeem', quote };
}

export function applyMint(v: LocalVault, c: ShareClass, quote: bigint, shares: bigint, now: number): LocalVault {
  const next: LocalVault = { ...v, ownedQuote: v.ownedQuote + quote };
  if (c === 'night') { next.nightSupply += shares; next.myNight += shares; }
  else { next.daySupply += shares; next.myDay += shares; }
  next.history = [
    { ts: now, kind: 'mint' as const, cls: c, shares, quote, nightNav: next.nightNav, dayNav: next.dayNav },
    ...v.history,
  ].slice(0, 24);
  return next;
}

export function applyRedeem(v: LocalVault, c: ShareClass, shares: bigint, quote: bigint, now: number): LocalVault {
  const next: LocalVault = { ...v, ownedQuote: v.ownedQuote - quote };
  if (c === 'night') { next.nightSupply -= shares; next.myNight -= shares; }
  else { next.daySupply -= shares; next.myDay -= shares; }
  next.history = [
    { ts: now, kind: 'redeem' as const, cls: c, shares, quote, nightNav: next.nightNav, dayNav: next.dayNav },
    ...v.history,
  ].slice(0, 24);
  return next;
}

/**
 * Run every boundary the vault has slept through, in order.
 *
 * This is the same walk the keeper does on chain, and it uses the same
 * `settle()`. Marks between boundaries are not available in a browser, so each
 * missed boundary settles at the current mark — which understates intermediate
 * moves and is stated as such on the page rather than smoothed over.
 */
export function advance(v: LocalVault, mark: bigint, now: number): LocalVault {
  if (v.halted || mark <= 0n) return v;

  let cur = v;
  let guard = 0;
  while (guard++ < 40) {
    const b = nextBoundary(cur.lastBoundaryTs, 20);
    if (b === null || b > now) break;

    const state: NavState = {
      nightSupply: cur.nightSupply,
      daySupply: cur.daySupply,
      ownedUnderlying: cur.ownedUnderlying,
      nightNav: cur.nightNav,
      dayNav: cur.dayNav,
      exposed: cur.exposed,
      lastMark: cur.lastMark,
    };
    const r = settle(state, mark, DEFAULT_FUNDING);

    // What the vault is worth at this mark, before the handoff. The fill
    // below rearranges it between stock and quote; it must not change it.
    const assets = mulDivFloor(cur.ownedUnderlying, mark, WAD) + cur.ownedQuote;

    cur = {
      ...cur,
      nightNav: r.nightNav,
      dayNav: r.dayNav,
      exposed: r.exposed,
      lastMark: mark,
      lastBoundaryTs: b,
      pendingDelta: r.handoffDelta,
      halted: r.shortfall > 0n,
      haltReason: r.shortfall > 0n ? 'bad debt' : cur.haltReason,
      history: [
        {
          ts: b, kind: 'settle' as const,
          nightNav: r.nightNav, dayNav: r.dayNav,
          funding: r.funding, handoffDelta: r.handoffDelta,
        },
        ...cur.history,
      ].slice(0, 24),
    };

    // A filled handoff. After a boundary the exposed class is long the stock
    // and everything else sits in quote. The vault buys exactly the atoms the
    // exposed class's value warrants — floored, the way a fill is — and *keeps
    // the rounding residual as quote* rather than dropping it. That is what
    // the on-chain fill does (`owned_quote_after = owned_quote - quote_paid`),
    // and it is why backing never dips below claims by a stray atom: the
    // vault's assets are rearranged by a fill, never reduced by one.
    //
    // On chain a filler does this and is paid an incentive; here it is assumed
    // filled at the mark, which is the optimistic case. The page says so.
    if (!cur.halted) {
      const need = r.exposed === 'night' ? r.valueNight : r.valueDay;
      cur.ownedUnderlying = mulDivFloor(need, WAD, mark);
      const inStock = mulDivFloor(cur.ownedUnderlying, mark, WAD);
      cur.ownedQuote = assets > inStock ? assets - inStock : 0n;
      cur.pendingDelta = 0n;
    }
  }

  return cur;
}

/* ── persistence ─────────────────────────────────────────────────────────── */

const key = (symbol: string) => `session.vault.${symbol}`;

const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v);
const reviver = (_k: string, v: unknown) =>
  typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v;

export function loadVault(symbol: string): LocalVault | null {
  try {
    const raw = localStorage.getItem(key(symbol));
    return raw ? (JSON.parse(raw, reviver) as LocalVault) : null;
  } catch {
    return null;   // private mode, blocked storage, or a shape from an old build
  }
}

export function saveVault(v: LocalVault): void {
  try { localStorage.setItem(key(v.symbol), JSON.stringify(v, replacer)); } catch { /* fine */ }
}

export function clearVault(symbol: string): void {
  try { localStorage.removeItem(key(symbol)); } catch { /* fine */ }
}

/* ── formatting ──────────────────────────────────────────────────────────── */

export const fromQuote = (v: bigint): number => Number(v) / Number(QUOTE_UNIT);
export const toQuote = (n: number): bigint => BigInt(Math.round(n * Number(QUOTE_UNIT)));
export const fromShares = (v: bigint): number => Number(v) / Number(SHARE_UNIT);
export const toShares = (n: number): bigint => BigInt(Math.round(n * Number(SHARE_UNIT)));
/** NAV as a plain ratio: 1.0 is one unit of quote per share. */
export const navToNumber = (nav: bigint): number => Number(nav) / Number(WAD);
