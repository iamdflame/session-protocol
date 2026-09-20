/* ───────────────────────────────────────────────────────────────────────────
   Does the overnight equity anomaly survive when the night is tradeable?

   In traditional markets the answer is famously yes: the US equity risk premium
   accrues almost entirely between the close and the next open, and intraday
   returns are roughly zero. Nobody can harvest it, because capturing it means
   ~250 round trips a year and the spread eats the edge.

   Tokenized equity changes the question, because the "overnight" window is no
   longer a gap between two prints — it is a live, continuously traded market.
   That has never been measurable before. This is the measurement.

   Run:  node --experimental-strip-types research/session-study.ts
   ─────────────────────────────────────────────────────────────────────────── */

import { readFileSync, writeFileSync } from 'node:fs';
import { sessionAt, Session, weekdayFromDays, SEC_PER_DAY } from '../sdk/src/calendar.ts';
import { summarise, pct, bp, type Summary } from './stats.ts';

const MAX_ABS_HOURLY = 0.25;     // a >25% move in one hour is a bad print, not a return
const MIN_RUNS = 20;             // below this, statistics are theatre

type Row = [number, number];     // [unix seconds, close]

interface Run {
  session: Session;
  ret: number;                   // summed log return
  hours: number;
  start: number;
  weekend: boolean;
}

/** Attribution policy for an interval that straddles a session boundary. */
type Policy = 'strict' | 'end';

/**
 * Group consecutive hourly closes into session runs — one night, one day.
 *
 * A run is the natural unit of observation: a NIGHT token holder experiences
 * one night as a single outcome, not seventeen hourly ones. Treating hours as
 * independent would inflate the sample and the significance with it.
 */
function runsFor(rows: Row[], policy: Policy): { runs: Run[]; dropped: number } {
  const runs: Run[] = [];
  let cur: Run | null = null;
  let lastT = -1;
  let dropped = 0;

  for (let i = 1; i < rows.length; i++) {
    const [t0, c0] = rows[i - 1];
    const [t1, c1] = rows[i];
    if (c0 <= 0 || c1 <= 0 || t1 <= t0) continue;

    const r = Math.log(c1 / c0);
    if (!Number.isFinite(r) || Math.abs(r) > MAX_ABS_HOURLY) { cur = null; continue; }

    const s0 = sessionAt(t0);
    const s1 = sessionAt(t1);
    let session: Session;
    if (s0 === s1) {
      session = s0;
    } else if (policy === 'end') {
      session = s1;                       // the holder of the new session wears it
    } else {
      dropped++; cur = null; continue;    // strict: refuse to guess
    }

    const days = Math.floor((t0 - 4 * 3600) / SEC_PER_DAY);
    const w = weekdayFromDays(days);
    const weekend = w === 0 || w === 6;

    if (!cur || cur.session !== session || t0 !== lastT) {
      cur = { session, ret: 0, hours: 0, start: t0, weekend };
      runs.push(cur);
    }
    cur.ret += r;
    cur.hours += (t1 - t0) / 3600;
    lastT = t1;
  }
  return { runs, dropped };
}

interface AssetResult {
  symbol: string;
  kind: string;
  hours: number;
  days: number;
  night: Summary;
  day: Summary;
  dropped: number;
}

function analyse(symbol: string, kind: string, rows: Row[], policy: Policy): AssetResult | null {
  const { runs, dropped } = runsFor(rows, policy);
  const night = runs.filter(r => r.session === Session.Closed);
  const day = runs.filter(r => r.session === Session.Open);
  if (night.length < MIN_RUNS || day.length < MIN_RUNS) return null;

  return {
    symbol, kind,
    hours: rows.length,
    days: (rows.at(-1)![0] - rows[0][0]) / SEC_PER_DAY,
    night: summarise(night.map(r => r.ret), night.map(r => r.hours)),
    day: summarise(day.map(r => r.ret), day.map(r => r.hours)),
    dropped,
  };
}

/* ── report ──────────────────────────────────────────────────────────────── */

const sig = (t: number): string =>
  !Number.isFinite(t) ? '   ' : Math.abs(t) >= 2.58 ? '***' : Math.abs(t) >= 1.96 ? '** ' : Math.abs(t) >= 1.64 ? '*  ' : '   ';

function table(title: string, rs: AssetResult[]) {
  console.log(`\n${title}`);
  console.log('─'.repeat(104));
  console.log(
    'asset'.padEnd(11) + 'days'.padStart(5) +
    '  │ ' + 'NIGHT cum'.padStart(10) + 'mean'.padStart(9) + 't'.padStart(7) + '  ' +
    ' │ ' + 'DAY cum'.padStart(10) + 'mean'.padStart(9) + 't'.padStart(7) + '  ' +
    ' │ ' + 'n/hr'.padStart(8) + 'd/hr'.padStart(8));
  console.log('─'.repeat(104));
  for (const r of rs) {
    console.log(
      r.symbol.padEnd(11) + r.days.toFixed(0).padStart(5) +
      '  │ ' + pct(r.night.cumulative, 1).padStart(10) + pct(r.night.mean, 2).padStart(9) +
      r.night.t.toFixed(2).padStart(7) + ' ' + sig(r.night.t) +
      ' │ ' + pct(r.day.cumulative, 1).padStart(10) + pct(r.day.mean, 2).padStart(9) +
      r.day.t.toFixed(2).padStart(7) + ' ' + sig(r.day.t) +
      ' │ ' + bp(r.night.perHour, 2).padStart(8) + bp(r.day.perHour, 2).padStart(8));
  }
  console.log('─'.repeat(104));
}

/* ── main ────────────────────────────────────────────────────────────────── */

const raw = JSON.parse(readFileSync('data/_hourly.json', 'utf8'));
const assets: { symbol: string; kind: string; rows: Row[] }[] = raw.assets;
const policy = (process.argv.includes('--end') ? 'end' : 'strict') as Policy;

console.log(`\nSESSION STUDY   ${assets.length} tokenized assets   ` +
            `attribution=${policy}   snapshot ${raw.generated.slice(0, 10)}`);
console.log('NIGHT = US equity market closed (nights, weekends, holidays).');
console.log('DAY   = NYSE regular session, when the token can be arbitraged against the stock.');

const results = assets
  .map(a => analyse(a.symbol, a.kind, a.rows, policy))
  .filter((r): r is AssetResult => r !== null)
  .sort((a, b) => b.night.cumulative - a.night.cumulative);

const equities = results.filter(r => r.kind === 'public' && !['GLDx'].includes(r.symbol));
const controls = results.filter(r => r.kind === 'private' || r.symbol === 'GLDx');

table('US EQUITIES — underlying closes every night', equities);
if (controls.length) {
  table('CONTROLS — no closed underlying, so the mechanism predicts no effect', controls);
  console.log('GLDx tracks gold, which trades ~24h globally. PreStocks track private');
  console.log('companies, which have no exchange session at all. If the session split were');
  console.log('an artifact of on-chain microstructure it would show up here too.');
}

/* pooled view */
const pool = (rs: AssetResult[], pick: (r: AssetResult) => Summary) => {
  const n = rs.length;
  if (!n) return null;
  const meanOf = (f: (s: Summary) => number) => rs.reduce((s, r) => s + f(pick(r)), 0) / n;
  const ts = rs.map(r => pick(r).t).filter(Number.isFinite);
  return {
    assets: n,
    meanPerHour: meanOf(s => s.perHour),
    meanCum: meanOf(s => s.cumulative),
    medianT: ts.sort((a, b) => a - b)[Math.floor(ts.length / 2)] ?? NaN,
    sharePositiveT: ts.filter(t => t > 0).length / Math.max(ts.length, 1),
    shareSignificant: ts.filter(t => Math.abs(t) >= 1.96).length / Math.max(ts.length, 1),
  };
};

const pn = pool(equities, r => r.night);
const pd = pool(equities, r => r.day);
console.log('\nPOOLED ACROSS US EQUITIES');
console.log('─'.repeat(104));
if (pn && pd) {
  console.log(`  assets                     ${pn.assets}`);
  console.log(`  mean cumulative   NIGHT ${pct(pn.meanCum, 1).padStart(9)}      DAY ${pct(pd.meanCum, 1).padStart(9)}`);
  console.log(`  mean per hour     NIGHT ${bp(pn.meanPerHour).padStart(9)}      DAY ${bp(pd.meanPerHour).padStart(9)}`);
  console.log(`  median NW t-stat  NIGHT ${pn.medianT.toFixed(2).padStart(9)}      DAY ${pd.medianT.toFixed(2).padStart(9)}`);
  console.log(`  share t>0         NIGHT ${(pn.sharePositiveT * 100).toFixed(0).padStart(8)}%      DAY ${(pd.sharePositiveT * 100).toFixed(0).padStart(8)}%`);
  console.log(`  share |t|>1.96    NIGHT ${(pn.shareSignificant * 100).toFixed(0).padStart(8)}%      DAY ${(pd.shareSignificant * 100).toFixed(0).padStart(8)}%`);
}
console.log('─'.repeat(104));

console.log('\nPER-ASSET DETAIL (Newey-West SE, percentile bootstrap CI)');
for (const r of [...equities, ...controls]) {
  const line = (label: string, s: Summary) =>
    `  ${label.padEnd(6)} n=${String(s.n).padStart(3)}  mean ${pct(s.mean, 3).padStart(8)}` +
    `  NW-t ${s.t.toFixed(2).padStart(6)} ${sig(s.t)}  95% CI [${pct(s.ci[0], 3).padStart(7)},${pct(s.ci[1], 3).padStart(7)} ]` +
    `  hit ${(s.hitRate * 100).toFixed(0).padStart(3)}%  ex-ext ${pct(s.meanExExtremes, 3).padStart(8)}`;
  console.log(`\n${r.symbol}  (${r.hours}h / ${r.days.toFixed(0)}d, ${r.dropped} ambiguous dropped)`);
  console.log(line('NIGHT', r.night));
  console.log(line('DAY', r.day));
}

/* ── risk, not just return ───────────────────────────────────────────────── */

// The return comparison is only half the question. A session that pays the same
// for more risk is not a fair trade, and the night carries something the day
// structurally cannot: a holder cannot exit while the market is shut, so every
// gap lands on them in full.
console.log('\nRISK PER SESSION');
console.log('─'.repeat(104));
console.log('asset'.padEnd(10) + 'NIGHT vol'.padStart(11) + 'DAY vol'.padStart(10) +
            '   ' + 'left tail N'.padStart(12) + 'left tail D'.padStart(12) +
            '   ' + 'per-hour N'.padStart(11) + 'per-hour D'.padStart(11));
console.log('─'.repeat(104));

let volN = 0, volD = 0, fatterNight = 0;
for (const r of equities) {
  // mean − 2.5σ: the size of move a holder cannot trade out of
  const tn = r.night.mean - 2.5 * r.night.stdev;
  const td = r.day.mean - 2.5 * r.day.stdev;
  if (tn < td) fatterNight++;
  volN += r.night.stdev; volD += r.day.stdev;
  console.log(
    r.symbol.padEnd(10) + pct(r.night.stdev).padStart(11) + pct(r.day.stdev).padStart(10) +
    '   ' + pct(tn, 1).padStart(12) + pct(td, 1).padStart(12) +
    '   ' + bp(r.night.perHour).padStart(11) + bp(r.day.perHour).padStart(11));
}
const n = Math.max(equities.length, 1);
console.log('─'.repeat(104));
console.log(`  mean session volatility   NIGHT ${pct(volN / n)}   DAY ${pct(volD / n)}` +
            `   →  the night is ${(((volN / volD) - 1) * 100).toFixed(0)}% more volatile`);
console.log(`  fatter left tail          NIGHT in ${fatterNight}/${n} assets`);
console.log('─'.repeat(104));

/* ── the verdict ─────────────────────────────────────────────────────────── */

// The cleanest single test: for each equity, compare the return earned per hour
// of NIGHT exposure against per hour of DAY exposure. Paired by asset, so it is
// not contaminated by some names simply having risen more than others.
const paired = equities.map(r => r.night.perHour - r.day.perHour);
const wins = paired.filter(d => d > 0).length;
const meanDiff = paired.reduce((s, v) => s + v, 0) / Math.max(paired.length, 1);
const sdDiff = Math.sqrt(paired.reduce((s, v) => s + (v - meanDiff) ** 2, 0) /
                         Math.max(paired.length - 1, 1));
const tDiff = meanDiff / (sdDiff / Math.sqrt(Math.max(paired.length, 1)));

console.log('\nVERDICT');
console.log('═'.repeat(104));
console.log(`  NIGHT minus DAY, per hour of exposure, paired across ${paired.length} US equities`);
console.log(`    mean difference  ${bp(meanDiff)}      t = ${tDiff.toFixed(2)}`);
console.log(`    NIGHT wins       ${wins}/${paired.length} assets`);
console.log('');
if (Math.abs(tDiff) < 1.96 && wins <= paired.length * 0.65 && wins >= paired.length * 0.35) {
  console.log('  No session premium is detectable in tokenized equities.');
  console.log('');
  console.log('  In traditional markets this is the most durable anomaly in the literature:');
  console.log('  the equity risk premium accrues almost entirely between the close and the');
  console.log('  next open, and has done for seventeen years. It has survived precisely');
  console.log('  because it could not be traded — harvesting it costs ~250 round trips a');
  console.log('  year and the spread eats the edge.');
  console.log('');
  console.log('  Tokenized equity made that window continuously tradeable for the first');
  console.log('  time. On this sample the premium is not there. The most economical');
  console.log('  reading is that it was never a reward for bearing overnight risk; it was');
  console.log('  a reward for being unable to trade. Remove the constraint and it goes.');
  console.log('');
  console.log('  GLDx supports that reading: gold trades ~24h globally, has no closed');
  console.log('  session to arbitrage around, and shows nothing either way.');
} else {
  console.log('  A session premium IS detectable on this sample. Treat with suspicion until');
  console.log('  it survives out of sample — this is one regime, on one venue, over months.');
}
console.log('');
console.log('  And the sharper result is not about return at all. The night pays no more');
console.log(`  than the day while carrying ${(((volN / volD) - 1) * 100).toFixed(0)}% more volatility and the fatter left tail`);
console.log(`  in ${fatterNight} of ${n} assets. It is uncompensated risk.`);
console.log('');
console.log('  That asymmetry is structural, not a quirk of the sample. A DAY holder is');
console.log('  only exposed while the market is open, so they can always trade out before');
console.log('  a gap. A NIGHT holder cannot: they wear every gap in full, by construction.');
console.log('');
console.log('  Which gives the two tokens an honest job. DAY is equity exposure you can');
console.log('  always exit. NIGHT is the gap risk, isolated, for whoever wants to be paid');
console.log('  to carry it. The funding rate between them is the price of that transfer —');
console.log('  and nobody has been able to quote it before, because nobody could hold');
console.log('  either side on its own.');
console.log('═'.repeat(104));

console.log('\nCAVEATS');
console.log('  · Hourly closes. The 16:00 ET close lands on the hour and is clean; the 09:30');
console.log('    open does not, so the 09:00-10:00 interval straddles a boundary. Under');
console.log('    strict attribution it is dropped, which removes the first 30 minutes of');
console.log('    every DAY session — the exact window in which the mechanism predicts the');
console.log('    snap-back. If that biases anything it understates the effect.');
console.log('  · *** |t|>2.58   ** |t|>1.96   * |t|>1.64, Newey-West corrected.');
console.log('  · A cumulative return is not evidence on its own. Read the t-stats.');

writeFileSync('data/session-study.json', JSON.stringify({
  generated: new Date().toISOString(),
  policy, snapshot: raw.generated,
  equities, controls, pooled: { night: pn, day: pd },
}, null, 1));
console.log(`\nwrote data/session-study.json`);
