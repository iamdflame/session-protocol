/* ───────────────────────────────────────────────────────────────────────────
   What a wallet actually made, and what it would have made holding the whole
   thing instead.

   The pitch is that one of these two halves is mispriced. A holder can only
   check that against the alternative they gave up, which is the bundle — the
   undivided token, which is what every other product on this chain sells. So
   the statement carries three columns: NIGHT, DAY, and the same cash flows
   held as the asset itself.

   The benchmark is exact rather than indicative. NAV moves only at
   boundaries, and `BoundarySettled` carries both classes' NAV, so walking the
   event stream reconstructs the pair's value at every instant a wallet
   traded. One bundle unit is half a NIGHT share and half a DAY share, which
   is worth `(nightNav + dayNav) / 2` and tracks the mark by construction: the
   funding that moves between the classes nets to zero across the pair, which
   is the whole reason the split is fair.

   Nothing here reads the chain. It consumes decoded events, so the same
   function serves the site, a keeper report and a test.
   ─────────────────────────────────────────────────────────────────────────── */

import { WAD, mulDivFloor, type ShareClass } from './settle.ts';
import type { VaultEvent } from './events.ts';

/** One trade of this wallet's, priced at the NAVs that stood when it landed. */
export interface StatementRow {
  signature: string;
  /** Unix seconds, or null when the RPC did not carry a block time. */
  at: number | null;
  kind: 'mint' | 'redeem';
  cls: ShareClass;
  /** Share atoms, signed: positive on a mint, negative on a redeem. */
  shares: bigint;
  /** Quote atoms, signed: negative when paid in, positive when taken out. */
  quote: bigint;
  /** That class's NAV, from the event itself. */
  nav: bigint;
  /** `(nightNav + dayNav) / 2` — what one unit of the undivided asset cost. */
  bundleNav: bigint;
  /** Signed change in the shadow bundle position, in the same atoms. */
  bundleUnits: bigint;
}

export interface ClassPosition {
  cls: ShareClass;
  /** Net share atoms still held. */
  shares: bigint;
  quoteIn: bigint;
  quoteOut: bigint;
  /** Marked at the NAV passed to `statement()`. */
  value: bigint;
  /** `value + quoteOut − quoteIn`: realised and unrealised together. */
  pnl: bigint;
  trades: number;
}

export interface Statement {
  rows: StatementRow[];
  night: ClassPosition;
  day: ClassPosition;
  total: { quoteIn: bigint; quoteOut: bigint; value: bigint; pnl: bigint };
  /** The same cash flows, at the same instants, held as the undivided asset. */
  bundle: { units: bigint; value: bigint; pnl: bigint };
  /** What the split was worth against the alternative. Signed quote atoms. */
  versusBundle: bigint;
  navNight: bigint;
  navDay: bigint;
  bundleNav: bigint;
  /**
   * False when the walk never saw the vault open, so the NAVs before the
   * first boundary in view are assumed to be parity. The per-class figures
   * are still exact — every trade carries its own NAV — but the bundle
   * benchmark is only as good as that assumption, and a reader is told.
   */
  complete: boolean;
}

/** An event with the signature and time of the transaction that emitted it. */
export interface TimedEvent {
  signature: string;
  at: number | null;
  event: VaultEvent;
}

const ZERO = (cls: ShareClass): ClassPosition =>
  ({ cls, shares: 0n, quoteIn: 0n, quoteOut: 0n, value: 0n, pnl: 0n, trades: 0 });

/** Units bought for `quote` at `nav`, floored the way the program floors. */
const unitsFor = (quote: bigint, nav: bigint) => (nav > 0n ? mulDivFloor(quote, WAD, nav) : 0n);

/**
 * Build a wallet's statement from a vault's event stream.
 *
 * `events` may arrive in any order and may contain other wallets' trades and
 * every boundary in between — all of which are needed, because the boundaries
 * are what price the benchmark. Only `wallet`'s own mints and redeems become
 * rows.
 *
 * `navNight` / `navDay` are the vault's NAVs now, from chain state. Passing
 * them rather than inferring them keeps the statement honest about the mark
 * it is using: it is the same one the page shows beside it.
 */
export function statement(
  events: TimedEvent[],
  wallet: string,
  navNight: bigint,
  navDay: bigint,
): Statement {
  // Chronological, and stably so: several events share one block time, and a
  // mint priced before a boundary must not be walked after it.
  const ordered = [...events].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

  let night = WAD, day = WAD;          // parity at inception
  let complete = false;
  const rows: StatementRow[] = [];

  for (const { signature, at, event: e } of ordered) {
    const f = e.fields;
    switch (e.name) {
      case 'VaultInitialized':
        night = WAD; day = WAD; complete = true;
        break;

      // Both carry the pair after the move, which is what the next trade pays.
      case 'BoundarySettled':
      case 'Recapped':
        night = f.nightNav as bigint;
        day = f.dayNav as bigint;
        break;

      case 'SharesMinted':
      case 'SharesRedeemed': {
        const cls = f.class as ShareClass;
        const nav = f.nav as bigint;
        // The event's own NAV is authoritative for its class; it is the number
        // the program priced against. Adopting it also repairs the other
        // class's drift when a boundary is missing from the window.
        if (cls === 'night') night = nav; else day = nav;

        if (String(f.user) !== wallet) break;

        const mint = e.name === 'SharesMinted';
        const quote = mint ? -(f.quoteIn as bigint) : (f.quoteOut as bigint);
        const shares = mint ? (f.sharesOut as bigint) : -(f.sharesIn as bigint);
        const bundleNav = (night + day) / 2n;
        rows.push({
          signature, at, kind: mint ? 'mint' : 'redeem', cls, shares, quote, nav, bundleNav,
          // The shadow mirrors the cash, not the shares: money in buys the
          // bundle, money out sells exactly enough of it.
          bundleUnits: mint ? unitsFor(-quote, bundleNav) : -unitsFor(quote, bundleNav),
        });
        break;
      }
    }
  }

  const pos = { night: ZERO('night'), day: ZERO('day') };
  let units = 0n;
  for (const r of rows) {
    const p = pos[r.cls];
    p.shares += r.shares;
    p.trades += 1;
    if (r.quote < 0n) p.quoteIn += -r.quote; else p.quoteOut += r.quote;
    units += r.bundleUnits;
  }
  for (const p of [pos.night, pos.day]) {
    p.value = mulDivFloor(p.shares, p.cls === 'night' ? navNight : navDay, WAD);
    p.pnl = p.value + p.quoteOut - p.quoteIn;
  }

  const bundleNav = (navNight + navDay) / 2n;
  const bundleValue = mulDivFloor(units, bundleNav, WAD);
  const quoteIn = pos.night.quoteIn + pos.day.quoteIn;
  const quoteOut = pos.night.quoteOut + pos.day.quoteOut;
  const value = pos.night.value + pos.day.value;
  const pnl = value + quoteOut - quoteIn;

  return {
    rows,
    night: pos.night,
    day: pos.day,
    total: { quoteIn, quoteOut, value, pnl },
    bundle: { units, value: bundleValue, pnl: bundleValue + quoteOut - quoteIn },
    versusBundle: pnl - (bundleValue + quoteOut - quoteIn),
    navNight, navDay, bundleNav, complete,
  };
}

/* ── the file a person keeps ─────────────────────────────────────────────── */

const dp = (v: bigint, dec: number) => {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(dec + 1, '0');
  const out = dec === 0 ? s : `${s.slice(0, -dec)}.${s.slice(-dec)}`;
  return neg ? `-${out}` : out;
};
const nav4 = (v: bigint) => (Number(v) / Number(WAD)).toFixed(6);
const iso = (at: number | null) => (at ? new Date(at * 1000).toISOString() : '');

/**
 * The statement as CSV, trades then a summary block.
 *
 * Exact decimal strings, never floats: this is the file somebody reconciles
 * against a broker or hands to an accountant, and a rounded cent that does not
 * add up is worse than no file. The NAVs and the signature are on every row so
 * each one can be checked against the chain on its own.
 */
export function toCsv(
  st: Statement, opts: { symbol: string; decimals: number; cls?: (c: ShareClass) => string },
): string {
  const { symbol, decimals: d } = opts;
  const name = opts.cls ?? ((c: ShareClass) => c.toUpperCase());
  const q = (v: bigint) => dp(v, d);
  const out: string[] = [];

  out.push('time,action,class,shares,quote,nav,bundle_nav,bundle_units,signature');
  for (const r of st.rows) {
    out.push([
      iso(r.at), r.kind, `${symbol}.${name(r.cls)}`, q(r.shares), q(r.quote),
      nav4(r.nav), nav4(r.bundleNav), q(r.bundleUnits), r.signature,
    ].join(','));
  }

  out.push('');
  out.push('position,shares,quote_in,quote_out,value_now,pnl');
  for (const p of [st.night, st.day]) {
    out.push([`${symbol}.${name(p.cls)}`, q(p.shares), q(p.quoteIn), q(p.quoteOut), q(p.value), q(p.pnl)].join(','));
  }
  out.push(['total', '', q(st.total.quoteIn), q(st.total.quoteOut), q(st.total.value), q(st.total.pnl)].join(','));
  out.push([`${symbol} (bundle, same cash flows)`, q(st.bundle.units), q(st.total.quoteIn), q(st.total.quoteOut),
    q(st.bundle.value), q(st.bundle.pnl)].join(','));
  out.push(['split vs bundle', '', '', '', '', q(st.versusBundle)].join(','));

  out.push('');
  out.push(`nav_night,${nav4(st.navNight)}`);
  out.push(`nav_day,${nav4(st.navDay)}`);
  out.push(`nav_bundle,${nav4(st.bundleNav)}`);
  out.push(`generated,${new Date().toISOString()}`);
  if (!st.complete) {
    out.push('note,"vault opening not in the window read; the bundle benchmark assumes parity before the first boundary shown"');
  }
  return out.join('\n') + '\n';
}
