/* ───────────────────────────────────────────────────────────────────────────
   The boundary crank.

   `settle_boundary` is permissionless — anyone may call it, and it refuses to
   do anything unless the session has genuinely changed. This keeper exists so
   that somebody reliably does, twice a trading day, within seconds of the bell.

   It is deliberately thin. The protocol does not trust it: the program checks
   the calendar, the oracle freshness, Pyth's confidence band and the size of
   the move itself. A keeper that is late, absent, or malicious can delay a
   boundary but cannot mis-settle one.

     node --experimental-strip-types keeper/src/index.ts --schedule
     node --experimental-strip-types keeper/src/index.ts --watch
   ─────────────────────────────────────────────────────────────────────────── */

import {
  sessionAt, nextBoundary, Session, civilFromDays, weekdayFromDays,
  isDST, SEC_PER_DAY,
} from '../../sdk/src/calendar.ts';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Format a UTC instant in Eastern wall-clock, which is how a trader reads it. */
export function etString(ts: number): string {
  const et = ts + (isDST(ts) ? -4 : -5) * 3600;
  const days = Math.floor(et / SEC_PER_DAY);
  const s = et - days * SEC_PER_DAY;
  const { y, m, d } = civilFromDays(days);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} ` +
         `${DOW[weekdayFromDays(days)]} ${hh}:${mm} ${isDST(ts) ? 'EDT' : 'EST'}`;
}

export interface Boundary {
  ts: number;
  from: Session;
  to: Session;
  /** The class that takes the exposure after this boundary. */
  takes: 'NIGHT' | 'DAY';
  gapHours: number;
}

/** The next `n` boundaries after `from`. */
export function schedule(from: number, n = 10): Boundary[] {
  const out: Boundary[] = [];
  let t = from;
  for (let i = 0; i < n; i++) {
    const b = nextBoundary(t, 20);
    if (b === null) break;
    const before = sessionAt(b - 60);
    const after = sessionAt(b);
    out.push({
      ts: b,
      from: before,
      to: after,
      takes: after === Session.Closed ? 'NIGHT' : 'DAY',
      gapHours: (b - t) / 3600,
    });
    t = b;
  }
  return out;
}

function printSchedule(now: number) {
  const cur = sessionAt(now);
  console.log(`\nnow            ${etString(now)}`);
  console.log(`session        ${cur === Session.Open ? 'OPEN  — DAY holds the stock'
                                                     : 'CLOSED — NIGHT holds the stock'}`);
  console.log(`\nupcoming boundaries`);
  console.log('─'.repeat(72));
  for (const b of schedule(now, 10)) {
    const wait = b.gapHours >= 24
      ? `${(b.gapHours / 24).toFixed(1)}d`
      : `${b.gapHours.toFixed(1)}h`;
    console.log(
      `  ${etString(b.ts).padEnd(30)} ${b.takes.padEnd(6)} takes exposure` +
      `   after ${wait.padStart(6)}` +
      (b.gapHours > 20 ? '   ← weekend or holiday' : ''));
  }
  console.log('─'.repeat(72));
  console.log('A weekend is a single 65.5h NIGHT position. That is the point:');
  console.log('two thirds of every week is time nobody has been able to own separately.');
}

/* ── the watch loop ──────────────────────────────────────────────────────── */

export interface CrankResult {
  ts: number;
  ok: boolean;
  note: string;
}

/**
 * Fire `onBoundary` as each boundary passes.
 *
 * `settle_boundary` is idempotent by construction — it reverts with NoBoundary
 * unless the session actually changed — so retrying is always safe and a double
 * fire is harmless.
 */
export async function watch(
  onBoundary: (b: Boundary) => Promise<CrankResult>,
  opts: { now?: () => number; sleep?: (ms: number) => Promise<void>; maxIterations?: number } = {},
): Promise<CrankResult[]> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  const results: CrankResult[] = [];
  let iterations = 0;

  for (;;) {
    if (opts.maxIterations !== undefined && iterations++ >= opts.maxIterations) break;

    const t = now();
    const next = nextBoundary(t, 20);
    if (next === null) {
      await sleep(60_000);
      continue;
    }

    const waitMs = Math.max(0, (next - t) * 1000);
    // wake a little early, then settle a little late: the program will not
    // accept a boundary before the session has actually turned over
    if (waitMs > 5_000) {
      await sleep(Math.min(waitMs - 2_000, 15 * 60_000));
      continue;
    }
    await sleep(waitMs + 2_000);

    const after = sessionAt(now());
    const b: Boundary = {
      ts: next,
      from: after === Session.Open ? Session.Closed : Session.Open,
      to: after,
      takes: after === Session.Closed ? 'NIGHT' : 'DAY',
      gapHours: 0,
    };
    const r = await onBoundary(b);
    results.push(r);
    console.log(`[${etString(r.ts)}] ${r.ok ? 'settled' : 'FAILED '}  ${r.note}`);
  }
  return results;
}

/* ── entry point ─────────────────────────────────────────────────────────── */

const isMain = import.meta.url.endsWith(process.argv[1]?.split('/').pop() ?? '\0');
if (isMain && !process.argv.includes('--no-run')) {
  const now = Math.floor(Date.now() / 1000);

  if (process.argv.includes('--watch')) {
    console.log('watching for session boundaries (ctrl-c to stop)\n');
    printSchedule(now);
    await watch(async b => ({
      ts: b.ts,
      ok: true,
      note: `${b.takes} takes exposure — submit settle_boundary here ` +
            `(wire an RPC connection and the vault address to go live)`,
    }));
  } else {
    printSchedule(now);
    console.log('\n--watch to run the crank loop.');
  }
}
