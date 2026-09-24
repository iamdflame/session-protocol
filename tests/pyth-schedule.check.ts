/* Our NYSE calendar against the schedule Pyth publishes.

   The program settles on `calendar.rs`, pinned to `sdk/src/calendar.ts` by
   4,734 shared vectors. That proves the two implementations agree with each
   other; it cannot prove either agrees with the exchange. Pyth publishes the
   exchange's regular session for every US listing, holidays and half-days
   included, so this holds the calendar against it day by day, across every
   date Pyth has published an override for.

   Two sources that must agree, rather than one we trust. The negative
   controls at the bottom prove the comparison can fail. */

import { readFileSync } from 'node:fs';
import {
  SEC_PER_DAY, civilFromDays, daysFromCivil, earlyCloses, etOffset, holidays, isoDay, weekdayFromDays,
} from '../sdk/src/calendar.ts';
import {
  overrideYear, parseDaySpec, parseSchedule, parseSessions, type DaySpec, type Schedule,
} from '../sdk/src/pyth-schedule.ts';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ' — ' + detail}`);
  if (!ok) failed++;
};

const snap = JSON.parse(readFileSync('tests/vectors/pyth-schedule.json', 'utf8')) as {
  fetched: string;
  symbols: Record<string, { market_sessions: Record<string, string> }>;
};
const fetchedTs = Math.floor(Date.parse(snap.fetched) / 1000);
const fetchedDay = Math.floor((fetchedTs + etOffset(fetchedTs)) / SEC_PER_DAY);

/** Our calendar, expressed as a Pyth day spec. */
function ours(day: number): DaySpec {
  const w = weekdayFromDays(day);
  const { y } = civilFromDays(day);
  if (w === 0 || w === 6 || holidays(y).has(day)) return { kind: 'closed' };
  return { kind: 'ranges', ranges: [[9 * 60 + 30, earlyCloses(y).has(day) ? 13 * 60 : 16 * 60]] };
}

const key = (day: number) => {
  const { m, d } = civilFromDays(day);
  return `${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
};

/** Pyth's spec for a day, with each MMDD override placed in its year. */
function pyth(s: Schedule, day: number): DaySpec {
  const k = key(day);
  const o = s.overrides.get(k);
  if (o && overrideYear(k, fetchedDay) === civilFromDays(day).y) return o;
  return s.weekdays[(weekdayFromDays(day) + 6) % 7];
}

const same = (a: DaySpec, b: DaySpec) => JSON.stringify(a) === JSON.stringify(b);
const show = (s: DaySpec) =>
  s.kind === 'ranges' ? s.ranges.map(([a, b]) => `${a / 60 | 0}:${String(a % 60).padStart(2, '0')}-${b / 60 | 0}:${String(b % 60).padStart(2, '0')}`).join('&') : s.kind;

/** The span Pyth has published: from its earliest override to its latest. */
function published(s: Schedule): [number, number] {
  const days = [...s.overrides.keys()].map(k =>
    daysFromCivil(overrideYear(k, fetchedDay), Number(k.slice(0, 2)), Number(k.slice(2))));
  return [Math.min(...days), Math.max(...days)];
}

function mismatches(s: Schedule): string[] {
  const [from, to] = published(s);
  const out: string[] = [];
  for (let day = from; day <= to; day++) {
    const a = ours(day);
    const b = pyth(s, day);
    if (!same(a, b)) out.push(`${isoDay(day)}: calendar ${show(a)}, Pyth ${show(b)}`);
  }
  return out;
}

console.log(`\nPyth schedule snapshot of ${snap.fetched.slice(0, 10)}, ${Object.keys(snap.symbols).length} listings`);

let checkedDays = 0;
for (const [sym, v] of Object.entries(snap.symbols)) {
  let sessions;
  try {
    sessions = parseSessions(v.market_sessions as never);
  } catch (e) {
    check(`${sym} parses`, false, (e as Error).message);
    continue;
  }
  const reg = sessions.regular;
  const wk = reg.weekdays.map(show).join(',');
  check(`${sym} regular hours are 09:30-16:00 Monday to Friday, shut at the weekend`,
    wk === '9:30-16:00,9:30-16:00,9:30-16:00,9:30-16:00,9:30-16:00,closed,closed', wk);
  check(`${sym} pre-market, post-market and overnight schedules parse`,
    Boolean(sessions.preMarket && sessions.postMarket && sessions.overNight));
  const bad = mismatches(reg);
  const [from, to] = published(reg);
  checkedDays += to - from + 1;
  check(`${sym}: the calendar agrees with Pyth on every day ${isoDay(from)} to ${isoDay(to)}`,
    bad.length === 0, bad.slice(0, 4).join('; '));
}

/* ── the comparison can fail ─────────────────────────────────────────────── */

console.log('\nnegative controls');
const base = parseSessions(Object.values(snap.symbols)[0].market_sessions as never).regular;
const withOverride = (k: string, spec: string | null): Schedule => {
  const o = new Map(base.overrides);
  if (spec === null) o.delete(k); else o.set(k, parseDaySpec(spec));
  return { ...base, overrides: o };
};

// Thanksgiving 2026 falls inside the published span; forget Pyth's override for it.
const noThanksgiving = mismatches(withOverride('1126', null));
check('dropping Thanksgiving from Pyth is caught', noThanksgiving.some(m => m.startsWith('2026-11-26')),
  noThanksgiving.join('; ') || 'no mismatch reported');

// Turn the 27 November half-day into a full day.
const fullDay = mismatches(withOverride('1127', '0930-1600'));
check('a half-day read as a full day is caught', fullDay.some(m => m.startsWith('2026-11-27')),
  fullDay.join('; ') || 'no mismatch reported');

// Invent a closure on an ordinary Wednesday.
const invented = mismatches(withOverride('1014', 'C'));
check('a closure the calendar does not know is caught', invented.some(m => m.startsWith('2026-10-14')),
  invented.join('; ') || 'no mismatch reported');

/* ── the parser refuses what it does not understand ─────────────────────── */

console.log('\nthe parser');
const refuses = (label: string, f: () => unknown) => {
  let threw = false;
  try { f(); } catch { threw = true; }
  check(`refuses ${label}`, threw);
};
refuses('a zone it cannot convert', () => parseSchedule('Europe/London;C,C,C,C,C,C,C'));
refuses('six day specs', () => parseSchedule('America/New_York;C,C,C,C,C,C'));
refuses('an hour past midnight', () => parseDaySpec('0930-2430'));
refuses('an inverted range', () => parseDaySpec('1600-0930'));
refuses('overlapping ranges', () => parseDaySpec('0000-0500&0400-0900'));
refuses('an override written twice', () => parseSchedule('America/New_York;C,C,C,C,C,C,C;0101/C,0101/O'));
refuses('an override without a date', () => parseSchedule('America/New_York;C,C,C,C,C,C,C;/C'));
const night = parseDaySpec('0000-0400&2000-2400');
check('reads a split overnight range to the end of the day',
  night.kind === 'ranges' && night.ranges.length === 2 && night.ranges[1][1] === 24 * 60);

console.log(`\n${checkedDays} listing-days compared`);
console.log(failed ? `\n${failed} failed` : '\nthe calendar agrees with Pyth\'s published schedule');
process.exit(failed ? 1 : 0);
