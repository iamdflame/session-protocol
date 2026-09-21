/* The statement makes a claim a holder can act on — that one half of this
   thing is mispriced relative to the other — and the only way to check it is
   against the alternative they gave up. So the benchmark has to be exact, not
   indicative, and it has to be exact against the *program's* arithmetic
   rather than against a sketch of it. Every NAV below comes out of `settle()`
   itself. */

import { statement, toCsv, type TimedEvent } from '../sdk/src/statement.ts';
import { settle, WAD, valueOf, type NavState } from '../sdk/src/settle.ts';
import type { VaultEvent } from '../sdk/src/events.ts';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (!cond) { console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
  else console.log(`  ok   ${name}`);
};

const ME = 'MyWa11etPubkey11111111111111111111111111111';
const THEM = 'SomeoneE1se1111111111111111111111111111111';

/* ── a vault that actually runs ──────────────────────────────────────────── */

/** Builds an event stream by driving the real settlement maths. */
class Fixture {
  s: NavState;
  at = 1_700_000_000;
  events: TimedEvent[] = [];
  private n = 0;

  constructor(opts: { open?: boolean } = {}) {
    this.s = {
      nightNav: WAD, dayNav: WAD, nightSupply: 0n, daySupply: 0n,
      exposed: 'night', lastMark: WAD * 100n, ownedUnderlying: 0n,
    };
    if (opts.open !== false) this.push('VaultInitialized', { mark: this.s.lastMark, exposed: 'night' });
  }

  /* A filled vault holds exactly the exposed class's value in stock — that is
     what the handoff is for. Buying stock with every mint, as a first draft of
     this fixture did, leaves the exposed class carrying the other one's
     inventory too and doubles every move it earns. */
  private hedge() {
    const supply = this.s.exposed === 'night' ? this.s.nightSupply : this.s.daySupply;
    const nav = this.s.exposed === 'night' ? this.s.nightNav : this.s.dayNav;
    this.s.ownedUnderlying = (valueOf(supply, nav) * WAD) / this.s.lastMark;
  }

  private push(name: string, fields: Record<string, unknown>) {
    this.events.push({ signature: `sig${++this.n}`, at: this.at, event: { name, fields } as VaultEvent });
  }

  /** Mint `quote` atoms of a class at the NAV standing now. */
  mint(user: string, cls: 'night' | 'day', quote: bigint) {
    const nav = cls === 'night' ? this.s.nightNav : this.s.dayNav;
    const shares = (quote * WAD) / nav;
    if (cls === 'night') this.s.nightSupply += shares; else this.s.daySupply += shares;
    this.hedge();
    this.push('SharesMinted', { user, class: cls, quoteIn: quote, sharesOut: shares, nav, ownedQuote: 0n });
    this.at += 60;
    return shares;
  }

  redeem(user: string, cls: 'night' | 'day', shares: bigint) {
    const nav = cls === 'night' ? this.s.nightNav : this.s.dayNav;
    const quote = (shares * nav) / WAD;
    if (cls === 'night') this.s.nightSupply -= shares; else this.s.daySupply -= shares;
    this.hedge();
    this.push('SharesRedeemed', { user, class: cls, sharesIn: shares, quoteOut: quote, nav, ownedQuote: 0n });
    this.at += 60;
    return quote;
  }

  /** One boundary at `mark`, settled by the same function the chain runs. */
  bell(mark: bigint) {
    const r = settle(this.s, mark);
    this.s = {
      ...this.s, nightNav: r.nightNav, dayNav: r.dayNav, exposed: r.exposed, lastMark: mark,
    };
    this.hedge();                       // the handoff fills, as it should
    this.at += 3600;
    this.push('BoundarySettled', {
      ts: this.at, boundary: 1n, exposed: r.exposed, mark,
      nightNav: r.nightNav, dayNav: r.dayNav,
      nightSupply: this.s.nightSupply, daySupply: this.s.daySupply,
      funding: r.funding, pendingDelta: r.handoffDelta, ownedUnderlying: this.s.ownedUnderlying, ownedQuote: 0n,
    });
    return r;
  }
}

/* ── 1. holding both halves is holding the asset ─────────────────────────── */

console.log('\nthe bundle benchmark');
{
  const f = new Fixture();
  // Equal money into each class, so the wallet holds the undivided asset.
  f.mint(ME, 'night', 1_000_000n);
  f.mint(ME, 'day', 1_000_000n);
  f.bell(WAD * 104n);     // night runs +4%
  f.bell(WAD * 101n);     // day gives 3% back
  f.bell(WAD * 107n);

  const st = statement(f.events, ME, f.s.nightNav, f.s.dayNav);
  check('both halves, equally weighted, is the bundle',
    st.versusBundle < 4n && st.versusBundle > -4n, `off by ${st.versusBundle} atoms`);
  check('and it is not trivially zero because nothing moved', st.total.pnl !== 0n, `pnl ${st.total.pnl}`);
  check('the opening was seen, so the benchmark is exact', st.complete);
}

/* ── 2. the sign of the answer ───────────────────────────────────────────── */
{
  const f = new Fixture();
  f.mint(ME, 'day', 1_000_000n);
  f.mint(THEM, 'night', 1_000_000n);
  // NIGHT is exposed first, so this fall is worn entirely by the other wallet.
  f.bell(WAD * 90n);

  const st = statement(f.events, ME, f.s.nightNav, f.s.dayNav);
  check('sitting out the losing session beats the bundle', st.versusBundle > 0n, `${st.versusBundle}`);
  // Parked does not mean untouched: the fall made DAY the larger side, so DAY
  // pays funding to NIGHT. That is the mechanism working, and it is bounded by
  // the 50 bp cap — a parked class can never lose the session's move.
  check('parked means flat except for the funding it paid',
    st.total.pnl < 0n && -st.total.pnl < 5_000n, `pnl ${st.total.pnl} on 1,000,000 in`);
  check('the other wallet is not in this statement', st.night.trades === 0 && st.day.trades === 1);
}

/* ── 3. funding nets to zero across the pair ─────────────────────────────── */
{
  const f = new Fixture();
  // Lopsided on purpose: a balanced book has zero skew and moves no funding
  // at all, which would make the check below true for the wrong reason.
  f.mint(ME, 'night', 4_000_000n);
  f.mint(ME, 'day', 1_000_000n);
  const r = f.bell(WAD * 100n);   // flat mark: the only thing that moves is funding
  check('the fixture really does move funding — otherwise the next check is vacuous',
    r.funding !== 0n, `funding ${r.funding}`);

  const st = statement(f.events, ME, f.s.nightNav, f.s.dayNav);
  const sum = valueOf(f.s.nightSupply, f.s.nightNav) + valueOf(f.s.daySupply, f.s.dayNav);
  check('funding moves NAV between the classes without changing the pair',
    st.total.value >= sum - 4n && st.total.value <= sum + 4n, `${st.total.value} vs ${sum}`);
}

/* ── 4. realised, unrealised, and closing out ────────────────────────────── */

console.log('\nthe position');
{
  const f = new Fixture();
  const shares = f.mint(ME, 'day', 1_000_000n);
  f.bell(WAD * 110n);
  f.bell(WAD * 110n);     // DAY is exposed on the second leg, flat mark
  const out = f.redeem(ME, 'day', shares);

  const st = statement(f.events, ME, f.s.nightNav, f.s.dayNav);
  check('a closed position holds nothing', st.day.shares === 0n, `${st.day.shares}`);
  check('its value is zero', st.day.value === 0n);
  check('and the P&L is exactly what came back minus what went in',
    st.day.pnl === out - 1_000_000n, `${st.day.pnl} vs ${out - 1_000_000n}`);
  check('two trades recorded', st.day.trades === 2 && st.rows.length === 2);
}

/* ── 5. an incomplete window says so ─────────────────────────────────────── */
{
  const f = new Fixture({ open: false });
  f.mint(ME, 'night', 1_000_000n);
  const st = statement(f.events, ME, f.s.nightNav, f.s.dayNav);
  check('a window that misses the opening is marked incomplete', !st.complete);
  check('the per-class figures are still exact', st.night.quoteIn === 1_000_000n);
}

/* ── 6. order does not depend on the order it arrived in ─────────────────── */
{
  const f = new Fixture();
  f.mint(ME, 'day', 1_000_000n);
  f.bell(WAD * 120n);
  f.mint(ME, 'day', 1_000_000n);
  const forward = statement(f.events, ME, f.s.nightNav, f.s.dayNav);
  const backward = statement([...f.events].reverse(), ME, f.s.nightNav, f.s.dayNav);
  check('a stream read backwards gives the same statement',
    JSON.stringify(forward, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
    === JSON.stringify(backward, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/* ── 7. the position needs only your own trades; the benchmark needs all ── */
//
// This is what lets the site show a correct position off a handful of
// signatures while the comparison waits for the vault's whole history. If the
// two ever disagree, the panel is quietly showing one wallet a different P&L
// depending on how much of the chain it managed to read.
{
  console.log('\nwhat a position needs, and what the benchmark needs');
  const f = new Fixture();
  f.mint(THEM, 'night', 3_000_000n);          // somebody else's money
  f.mint(ME, 'day', 1_000_000n);
  f.bell(WAD * 108n);
  f.mint(ME, 'day', 500_000n);
  f.bell(WAD * 103n);
  f.redeem(ME, 'day', 400_000n);

  const all = statement(f.events, ME, f.s.nightNav, f.s.dayNav);
  // Only what this wallet's own share accounts would have seen.
  const mineOnly = f.events.filter(({ event: e }) =>
    (e.name === 'SharesMinted' || e.name === 'SharesRedeemed') && e.fields.user === ME);
  const mine = statement(mineOnly, ME, f.s.nightNav, f.s.dayNav);

  check('a wallet-only walk gives the same shares', mine.day.shares === all.day.shares,
    `${mine.day.shares} vs ${all.day.shares}`);
  check('the same cash in and out',
    mine.day.quoteIn === all.day.quoteIn && mine.day.quoteOut === all.day.quoteOut);
  check('the same value now, and the same P&L',
    mine.day.value === all.day.value && mine.day.pnl === all.day.pnl,
    `${mine.day.pnl} vs ${all.day.pnl}`);
  check('the same trades, and none of the other wallet\'s',
    mine.rows.length === all.rows.length && mine.rows.length === 3);

  check('but the wallet-only walk knows it cannot price the benchmark', !mine.complete);
  check('while the full walk can', all.complete);
  check('and the two benchmarks differ, which is why the flag exists',
    mine.bundle.value !== all.bundle.value, `${mine.bundle.value} vs ${all.bundle.value}`);
}

/* ── 7. the file ─────────────────────────────────────────────────────────── */

console.log('\nthe CSV');
{
  const f = new Fixture();
  f.mint(ME, 'day', 1_500_000n);
  f.bell(WAD * 105n);
  f.redeem(ME, 'day', 500_000n);

  const st = statement(f.events, ME, f.s.nightNav, f.s.dayNav);
  const csv = toCsv(st, { symbol: 'NVDAx', decimals: 6 });
  const lines = csv.trim().split('\n');

  check('a header and one row per trade',
    lines[0].startsWith('time,action,class') && lines.length > 4, `${lines.length} lines`);
  check('quote amounts are exact decimal strings, not floats',
    lines[1].includes('-1.500000'), lines[1]);
  check('every row carries its signature', st.rows.every(r => csv.includes(r.signature)));
  check('the summary names the benchmark', csv.includes('bundle, same cash flows'));
  check('and states the NAVs it marked at', csv.includes(`nav_day,`) && csv.includes('nav_bundle,'));
  const redeem = lines.find(l => l.includes(',redeem,'))!.split(',');
  check('a redeem gives quote back and gives shares up',
    redeem[4][0] !== '-' && redeem[3][0] === '-', redeem.join(','));
  check('no field carries a comma that would break a column',
    lines.every(l => l.split(',').length === lines[0].split(',').length || !l.startsWith('20')));
}

console.log(failed ? `\n${failed} failed` : '\nall statement checks passed');
process.exit(failed ? 1 : 0);
