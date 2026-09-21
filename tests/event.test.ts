/* The event session, mirrored from `programs/session/src/event.rs`.
 *
 * Both the keeper and the site used to ask the NYSE calendar whether a
 * PreStock had crossed a boundary. A PreStock has no NYSE calendar — that is
 * the entire reason the event session exists — so the crank fired when the
 * exchange happened to agree and the program's correct refusal came back
 * looking like a broken keeper.
 *
 * `eventSessionOpen` and `eventBoundaryDue` are the one implementation both
 * now use. These are the Rust cases, case for case, plus the freshness bound
 * that only the callers need: the program refuses a stale reading with
 * `DetectorStale`, and cranking on one wastes a fee to be told so.
 */
import { PublicKey } from '@solana/web3.js';
import {
  eventSessionOpen, eventBoundaryDue,
  type EventSchedule, type DetectorReading, type ScheduledEvent,
} from '../sdk/src/vault.ts';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (!cond) { console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
  else console.log(`  ok   ${name}`);
};

const HOUR = 3_600;
const T0 = 1_700_000_000;
const KEY = new PublicKey('11111111111111111111111111111111');
const WAD = 10n ** 18n;

/** Cents in, WAD out — the same scaling the detector poster uses. */
const det = (markCents: number, execCents: number, ts: number): DetectorReading => ({
  version: 2, bump: 255, vault: KEY, poster: KEY,
  mark: BigInt(markCents) * WAD / 100n,
  executable: BigInt(execCents) * WAD / 100n,
  ts, posts: 1n,
});
const flat = (ts: number) => det(100_00, 100_00, ts);

const sched = (events: ScheduledEvent[]): EventSchedule =>
  ({ version: 2, bump: 255, vault: KEY, events, updatedAt: T0 });
const NONE = sched([]);

/* ── which side is on risk ───────────────────────────────────────────────── */

console.log('\nwhich side is on risk');
check('between prints and at parity, NOW holds it',
  eventSessionOpen(NONE, flat(T0), T0, 1_000));

{
  const s = sched([{ ts: T0 + HOUR, windowSecs: 2 * HOUR, kind: 0 }]);
  check('before the print, NOW still has it', eventSessionOpen(s, flat(T0), T0, 1_000));
  check('at the print, THEN takes it', !eventSessionOpen(s, flat(T0), T0 + HOUR, 1_000));
  check('inside the window, THEN keeps it', !eventSessionOpen(s, flat(T0), T0 + 2 * HOUR, 1_000));
  check('the window is half-open: at its end NOW has it back',
    eventSessionOpen(s, flat(T0), T0 + 3 * HOUR, 1_000));
}

// The real OPENAI reading from the day the Rust test was written: marked at
// 995.88, executing at 1121.09 — 1,257 bp.
check('a real divergence flips it', !eventSessionOpen(NONE, det(99_588, 112_109, T0), T0, 1_000));
check('a wider tolerance leaves it with NOW',
  eventSessionOpen(NONE, det(99_588, 112_109, T0), T0, 2_000));
// SPACEX the same day: marked 153.30, executing at 119.68.
check('a discount diverges as much as a premium',
  !eventSessionOpen(NONE, det(15_330, 11_968, T0), T0, 1_000));
check('a missing reading is not a divergence',
  eventSessionOpen(NONE, det(0, 100_00, T0), T0, 1_000)
  && eventSessionOpen(NONE, det(100_00, 0, T0), T0, 1_000));

/* ── whether there is anything to settle ─────────────────────────────────── */

console.log('\nwhether there is anything to settle');
const vault = (lastSessionOpen: boolean, over = { maxPremiumBps: 1_000, maxStaleSecs: HOUR }) =>
  ({ lastSessionOpen, lastBoundaryTs: T0 - HOUR, ...over });

{
  const r = eventBoundaryDue(vault(true), NONE, flat(T0), T0);
  check('nothing to do when the state already matches', !r.due, r.why);
}
{
  const r = eventBoundaryDue(vault(true), NONE, det(99_588, 112_109, T0), T0);
  check('a premium past tolerance is a boundary', r.due, r.why);
}
{
  const r = eventBoundaryDue(vault(false), NONE, det(99_588, 112_109, T0), T0);
  check('and it is not a boundary twice — THEN already holds it', !r.due, r.why);
}
{
  const r = eventBoundaryDue(vault(false), NONE, flat(T0), T0);
  check('the premium coming back inside tolerance is a boundary the other way', r.due, r.why);
}
{
  const s = sched([{ ts: T0, windowSecs: 2 * HOUR, kind: 0 }]);
  check('a print window opening is a boundary',
    eventBoundaryDue(vault(true), s, flat(T0 + HOUR), T0 + HOUR).due);
  check('and its close is a boundary back',
    eventBoundaryDue(vault(false), s, flat(T0 + 2 * HOUR), T0 + 2 * HOUR).due);
}

/* ── the freshness bound, which is the caller's job ──────────────────────── */

console.log('\nthe reading has to be one the program would accept');
{
  // Past tolerance, so the side differs — but the reading is two hours old
  // against a one-hour bound, and the program refuses it with DetectorStale.
  const r = eventBoundaryDue(vault(true), NONE, det(99_588, 112_109, T0 - 2 * HOUR), T0);
  check('a stale reading is not a boundary, however far the premium has run', !r.due, r.why);
  check('and the reason says so rather than "not due"', /old against/.test(r.why), r.why);
}
{
  const r = eventBoundaryDue(vault(true), NONE, null, T0);
  check('no reading at all is not a boundary either', !r.due, r.why);
  check('and says that instead', /no reading/.test(r.why), r.why);
}
{
  const v = { lastSessionOpen: true, lastBoundaryTs: T0 + HOUR, maxPremiumBps: 1_000, maxStaleSecs: HOUR };
  const r = eventBoundaryDue(v, NONE, det(99_588, 112_109, T0), T0);
  check('a clock behind the last boundary refuses rather than settling backwards', !r.due, r.why);
}

console.log(failed ? `\n${failed} failed` : '\nall event-session checks passed');
process.exit(failed ? 1 : 0);
