/* ───────────────────────────────────────────────────────────────────────────
   Pyth's published market schedules, read the way Pyth writes them.

   Every Pyth Pro symbol carries its trading hours as a string:

     America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;
       0907/C,1126/C,1127/0930-1300,1224/0930-1300,1225/C,0101/C,…

   a timezone, then seven day specs for Monday to Sunday, then dated
   overrides. A day spec is `C` (closed), `O` (open all day) or one or more
   `HHMM-HHMM` ranges joined with `&`; `2400` is the end of the day. A US
   equity has one such string per market session — regular, pre-market,
   post-market and overnight — in `market_sessions`.

   Two uses here. The cost-of-the-night study tags every sample with the
   session it was taken in, finer than our calendar's open/closed. And a
   test holds our NYSE calendar against Pyth's regular-session string, day by
   day, so the calendar the program settles on and the schedule the oracle
   publishes under are two sources that must agree rather than one source we
   trust.

   Integer arithmetic only, like `calendar.ts`, whose Eastern-time offset this
   reuses: only `America/New_York` is accepted, because that is the only zone
   the calendar can convert without a timezone database.
   ─────────────────────────────────────────────────────────────────────────── */

import { SEC_PER_DAY, civilFromDays, daysFromCivil, etOffset, weekdayFromDays } from './calendar.ts';

/** Minutes after midnight, half-open: `[start, end)`. */
export type Range = readonly [number, number];

export type DaySpec =
  | { readonly kind: 'closed' }
  | { readonly kind: 'open' }
  | { readonly kind: 'ranges'; readonly ranges: readonly Range[] };

export interface Schedule {
  readonly tz: string;
  /** Monday first, as Pyth writes them. */
  readonly weekdays: readonly DaySpec[];
  /** Keyed `MMDD`. Pyth publishes month and day only; see `overrideYear`. */
  readonly overrides: ReadonlyMap<string, DaySpec>;
}

export class ScheduleError extends Error {}

const minutes = (hhmm: string): number => {
  if (!/^\d{4}$/.test(hhmm)) throw new ScheduleError(`not HHMM: ${hhmm}`);
  const h = Number(hhmm.slice(0, 2));
  const m = Number(hhmm.slice(2));
  if (m > 59 || h > 24 || (h === 24 && m !== 0)) throw new ScheduleError(`not a time of day: ${hhmm}`);
  return h * 60 + m;
};

export function parseDaySpec(spec: string): DaySpec {
  if (spec === 'C') return { kind: 'closed' };
  if (spec === 'O') return { kind: 'open' };
  const ranges = spec.split('&').map((r): Range => {
    const [a, b, ...rest] = r.split('-');
    if (a === undefined || b === undefined || rest.length) throw new ScheduleError(`not a range: ${r}`);
    const start = minutes(a);
    const end = minutes(b);
    if (end <= start) throw new ScheduleError(`empty or inverted range: ${r}`);
    return [start, end];
  });
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i][0] < ranges[i - 1][1]) throw new ScheduleError(`overlapping ranges: ${spec}`);
  }
  return { kind: 'ranges', ranges };
}

export function parseSchedule(s: string): Schedule {
  const parts = s.split(';');
  if (parts.length < 2 || parts.length > 3) throw new ScheduleError(`expected tz;days[;overrides]: ${s}`);
  const [tz, days, over = ''] = parts;
  if (tz !== 'America/New_York') {
    throw new ScheduleError(`only America/New_York can be converted without a timezone database, got ${tz}`);
  }
  const weekdays = days.split(',').map(parseDaySpec);
  if (weekdays.length !== 7) throw new ScheduleError(`expected 7 day specs, got ${weekdays.length}`);
  const overrides = new Map<string, DaySpec>();
  for (const o of over.split(',').filter(Boolean)) {
    const slash = o.indexOf('/');
    const mmdd = o.slice(0, slash);
    if (slash !== 4 || !/^\d{4}$/.test(mmdd)) throw new ScheduleError(`not MMDD/spec: ${o}`);
    if (overrides.has(mmdd)) throw new ScheduleError(`override for ${mmdd} appears twice`);
    overrides.set(mmdd, parseDaySpec(o.slice(slash + 1)));
  }
  return { tz, weekdays, overrides };
}

const mmdd = (days: number): string => {
  const { m, d } = civilFromDays(days);
  return `${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
};

/**
 * The day spec in force on an Eastern calendar day (days since the epoch, as
 * `calendar.ts` counts them). An override for the date wins over the weekday.
 */
export function daySpec(s: Schedule, etDay: number): DaySpec {
  const o = s.overrides.get(mmdd(etDay));
  if (o) return o;
  // weekdayFromDays is 0 = Sunday; Pyth's list is Monday first.
  return s.weekdays[(weekdayFromDays(etDay) + 6) % 7];
}

export function specContains(spec: DaySpec, minuteOfDay: number): boolean {
  if (spec.kind === 'closed') return false;
  if (spec.kind === 'open') return true;
  return spec.ranges.some(([a, b]) => minuteOfDay >= a && minuteOfDay < b);
}

/** Whether `ts` (unix seconds) falls inside the schedule. */
export function inSchedule(s: Schedule, ts: number): boolean {
  const et = ts + etOffset(ts);
  const day = Math.floor(et / SEC_PER_DAY);
  const minute = Math.floor((et - day * SEC_PER_DAY) / 60);
  return specContains(daySpec(s, day), minute);
}

/* ── market sessions ─────────────────────────────────────────────────────── */

/** Pyth Pro's `marketSession` values, in the order the wire format numbers them. */
export const MARKET_SESSIONS = ['regular', 'preMarket', 'postMarket', 'overNight', 'closed'] as const;
export type MarketSession = (typeof MARKET_SESSIONS)[number];

/** `market_sessions` as the symbols endpoint returns it, parsed. */
export interface SessionSchedules {
  readonly regular: Schedule;
  readonly preMarket?: Schedule;
  readonly postMarket?: Schedule;
  readonly overNight?: Schedule;
}

type RawSessions = Partial<Record<'regular' | 'pre_market' | 'post_market' | 'over_night', { schedule: string } | string>>;

export function parseSessions(raw: RawSessions): SessionSchedules {
  const str = (v: RawSessions[keyof RawSessions]) => (typeof v === 'string' ? v : v?.schedule);
  const regular = str(raw.regular);
  if (!regular) throw new ScheduleError('a market_sessions entry without a regular session');
  const opt = (v: RawSessions[keyof RawSessions]) => {
    const s = str(v);
    return s ? parseSchedule(s) : undefined;
  };
  return {
    regular: parseSchedule(regular),
    preMarket: opt(raw.pre_market),
    postMarket: opt(raw.post_market),
    overNight: opt(raw.over_night),
  };
}

/**
 * Which session Pyth's schedule places `ts` in. Regular hours are checked
 * first, so a malformed schedule that overlaps two sessions resolves to the
 * one that matters for settlement.
 */
export function marketSessionAt(s: SessionSchedules, ts: number): MarketSession {
  if (inSchedule(s.regular, ts)) return 'regular';
  if (s.preMarket && inSchedule(s.preMarket, ts)) return 'preMarket';
  if (s.postMarket && inSchedule(s.postMarket, ts)) return 'postMarket';
  if (s.overNight && inSchedule(s.overNight, ts)) return 'overNight';
  return 'closed';
}

/**
 * Pyth writes overrides as `MMDD` with no year. A snapshot taken on
 * `fetchedDay` lists recent past dates and roughly the coming year, so an
 * override belongs to the year that puts it within `[fetchedDay − back,
 * fetchedDay − back + 366)`. Only the schedule check needs this; live
 * tagging reads today's date, where there is no ambiguity.
 */
export function overrideYear(mmddKey: string, fetchedDay: number, backDays = 60): number {
  const from = fetchedDay - backDays;
  const { y } = civilFromDays(from);
  for (const year of [y, y + 1]) {
    const m = Number(mmddKey.slice(0, 2));
    const d = Number(mmddKey.slice(2));
    const days = daysFromCivil(year, m, d);
    if (days >= from && days < from + 366) return year;
  }
  throw new ScheduleError(`override ${mmddKey} does not fall within a year of the snapshot`);
}
