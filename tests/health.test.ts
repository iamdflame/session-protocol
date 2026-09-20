/* Health thresholds decide when somebody gets woken up. They are worth testing
   for the same reason the settlement maths is: getting them wrong is silent. */

import { evaluate, format, Severity, type VaultState } from '../sdk/src/health.ts';
import { WAD } from '../sdk/src/settle.ts';
import { daysFromCivil, SEC_PER_DAY } from '../sdk/src/calendar.ts';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (!cond) { console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
  else console.log(`  ok   ${name}`);
};

// Monday 2026-09-21, EDT (ET = UTC-4)
const mon = (h: number, m = 0) => daysFromCivil(2026, 9, 21) * SEC_PER_DAY + (h + 4) * 3600 + m * 60;

/** A healthy vault mid-session: balanced classes, hedged, everything fresh. */
function healthy(now: number): VaultState {
  return {
    halted: false,
    haltReason: 'None',
    paused: 0,
    nightSupply: 1_000_000n,
    daySupply: 1_000_000n,
    nightNav: WAD,
    dayNav: WAD,
    lastMark: WAD * 2n,
    ownedUnderlying: 500_000n,          // 500k × 2 = 1,000,000 quote of stock
    ownedQuote: 1_000_000n,
    balanceUnderlying: 500_000n,
    balanceQuote: 1_000_000n,
    pendingDelta: 0n,
    lastBoundaryTs: mon(9, 30),
    lastSessionOpen: true,
    maxCarryDeltaBps: 200,
    markPublishTs: now - 5,
    equityPublishTs: now - 5,
    maxStaleSecs: 120,
    equityQuietSecs: 900,
    maxUnexpectedClosedSecs: 21_600,
  };
}

const now = mon(12);

console.log('\nhealthy vault');
{
  const h = evaluate(healthy(now), now);
  check('reports ok', h.severity === Severity.Ok, format(h));
  check('margin is zero', h.margin === 0n, `${h.margin}`);
  check('crank is punctual', h.crankLateSecs === 0);
}

console.log('\ninsolvency');
{
  const v = healthy(now);
  v.ownedQuote = 999_000n;                        // 1000 short
  const h = evaluate(v, now);
  check('is critical', h.severity === Severity.Critical);
  check('names the shortfall', h.margin === -1_000n, `${h.margin}`);
  check('signals insolvent', h.signals.some(s => s.id === 'insolvent'));
}

console.log('\ncrank running late');
{
  // last settled at the open; it is now well past the close
  const late = mon(16) + 20 * 60;
  const v = healthy(late);
  v.lastBoundaryTs = mon(9, 30);
  const h = evaluate(v, late);
  check('warns after 15 minutes', h.signals.some(s => s.id === 'crank-late' && s.severity === Severity.Warning),
        format(h));

  // and escalates as the window to recover closes
  const veryLate = mon(16) + 6 * 3600;
  const v2 = healthy(veryLate);
  v2.lastBoundaryTs = mon(9, 30);
  const h2 = evaluate(v2, veryLate);
  check('escalates to critical near the next boundary',
        h2.signals.some(s => s.id === 'crank-late' && s.severity === Severity.Critical), format(h2));
}

console.log('\nunfilled handoff approaching the carry limit');
{
  const v = healthy(now);
  v.pendingDelta = 20_000n;                       // 100bp of 2,000,000 claims
  const h = evaluate(v, now);
  check('reports carry in bps', h.carryBps === 100, `${h.carryBps}`);
  check('warns at half the limit', h.signals.some(s => s.id === 'unfilled-handoff' && s.severity === Severity.Warning),
        format(h));

  const v2 = healthy(now);
  v2.pendingDelta = 60_000n;                      // 300bp, past the 200bp limit
  const h2 = evaluate(v2, now);
  check('critical at the limit', h2.signals.some(s => s.id === 'unfilled-handoff' && s.severity === Severity.Critical));
}

console.log('\nequity feed quiet during a nominal session');
{
  const v = healthy(now);
  v.equityPublishTs = now - 3_600;                // an hour of silence at midday
  const h = evaluate(v, now);
  check('warns', h.signals.some(s => s.id === 'equity-feed-quiet' && s.severity === Severity.Warning), format(h));

  const v2 = healthy(now);
  v2.equityPublishTs = now - 40_000;              // past max_unexpected_closed_secs
  const h2 = evaluate(v2, now);
  check('escalates to critical', h2.signals.some(s => s.id === 'equity-feed-quiet' && s.severity === Severity.Critical));
}

console.log('\nequity feed quiet OUTSIDE market hours is not a fault');
{
  const night = mon(22);                          // 22:00 ET, market shut
  const v = healthy(night);
  v.lastBoundaryTs = mon(16);
  v.lastSessionOpen = false;
  v.equityPublishTs = night - 6 * 3600;           // silent since the close, as designed
  const h = evaluate(v, night);
  check('does not flag the equity feed',
        !h.signals.some(s => s.id === 'equity-feed-quiet'), format(h));
}

console.log('\ndonated tokens');
{
  const v = healthy(now);
  v.balanceQuote = v.ownedQuote + 777n;
  const h = evaluate(v, now);
  check('flags surplus for skimming', h.signals.some(s => s.id === 'surplus'));
  check('is only a notice', h.severity === Severity.Notice, format(h));
}

console.log('\nbalances below what the vault believes it owns');
{
  const v = healthy(now);
  v.balanceUnderlying = v.ownedUnderlying - 1n;
  const h = evaluate(v, now);
  check('is critical', h.signals.some(s => s.id === 'balance-shortfall' && s.severity === Severity.Critical));
}

console.log('\nhalted vault');
{
  const v = healthy(now);
  v.halted = true;
  v.haltReason = 'MissedBoundary';
  const h = evaluate(v, now);
  check('is critical', h.severity === Severity.Critical);
  check('names the reason', h.signals.some(s => s.message.includes('MissedBoundary')));
}

console.log(failed ? `\n${failed} FAILURES` : '\nall health checks passed');
process.exit(failed ? 1 : 0);
