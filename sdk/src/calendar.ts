/* ───────────────────────────────────────────────────────────────────────────
   NYSE session calendar.

   This is the most safety-critical pure function in the protocol: it decides
   when a boundary fires, and therefore who earns the next stretch of return.
   The on-chain programs, through `crates/session-core/src/calendar.rs`, run the same
   algorithm, and `tests/vectors/calendar.json` proves the two agree.

   Deliberately written with integer arithmetic only — no Date, no timezone
   database, no dependencies. A timezone library that updates underneath a
   deployed program would silently move money between two token classes.
   ─────────────────────────────────────────────────────────────────────────── */

export const SEC_PER_DAY = 86400;

/** Howard Hinnant's civil-from-days / days-from-civil. Exact for all years. */
export function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;                                  // [0, 399]
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z: number): { y: number; m: number; d: number } {
  z += 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;                               // [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524)
                          - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

/** 0 = Sunday. 1970-01-01 was a Thursday, so day 0 maps to 4. */
export function weekdayFromDays(days: number): number {
  return ((days % 7) + 7 + 4) % 7;
}

/** Day number of the nth `dow` in a month (n is 1-based). */
function nthWeekdayOfMonth(y: number, m: number, dow: number, n: number): number {
  const first = daysFromCivil(y, m, 1);
  const shift = ((dow - weekdayFromDays(first)) + 7) % 7;
  return first + shift + (n - 1) * 7;
}

/** Day number of the last `dow` in a month. */
function lastWeekdayOfMonth(y: number, m: number, dow: number): number {
  const nextMonthFirst = m === 12 ? daysFromCivil(y + 1, 1, 1) : daysFromCivil(y, m + 1, 1);
  const last = nextMonthFirst - 1;
  return last - (((weekdayFromDays(last) - dow) + 7) % 7);
}

/** Anonymous Gregorian computus — Good Friday is the only movable NYSE holiday. */
export function easterSunday(y: number): number {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const mm = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * mm + 114) / 31);
  const day = ((h + l - 7 * mm + 114) % 31) + 1;
  return daysFromCivil(y, month, day);
}

/** Weekend holidays shift: Saturday → observed Friday, Sunday → observed Monday. */
function observed(days: number): number {
  const w = weekdayFromDays(days);
  if (w === 6) return days - 1;   // Saturday
  if (w === 0) return days + 1;   // Sunday
  return days;
}

/** Full-day NYSE closures for a calendar year, as day numbers. */
export function holidays(y: number): Set<number> {
  const s = new Set<number>();
  s.add(observed(daysFromCivil(y, 1, 1)));                  // New Year's Day
  s.add(nthWeekdayOfMonth(y, 1, 1, 3));                     // MLK — 3rd Mon Jan
  s.add(nthWeekdayOfMonth(y, 2, 1, 3));                     // Presidents — 3rd Mon Feb
  s.add(easterSunday(y) - 2);                               // Good Friday
  s.add(lastWeekdayOfMonth(y, 5, 1));                       // Memorial — last Mon May
  s.add(observed(daysFromCivil(y, 6, 19)));                 // Juneteenth
  s.add(observed(daysFromCivil(y, 7, 4)));                  // Independence Day
  s.add(nthWeekdayOfMonth(y, 9, 1, 1));                     // Labor — 1st Mon Sep
  s.add(nthWeekdayOfMonth(y, 11, 4, 4));                    // Thanksgiving — 4th Thu Nov
  s.add(observed(daysFromCivil(y, 12, 25)));                // Christmas
  return s;
}

/** Scheduled 13:00 ET early closes. */
export function earlyCloses(y: number): Set<number> {
  const s = new Set<number>();
  const hol = holidays(y);

  // July 3, when it is itself a weekday and not the observed holiday
  const jul3 = daysFromCivil(y, 7, 3);
  const w3 = weekdayFromDays(jul3);
  if (w3 >= 1 && w3 <= 5 && !hol.has(jul3)) s.add(jul3);

  // Friday after Thanksgiving
  s.add(nthWeekdayOfMonth(y, 11, 4, 4) + 1);

  // Christmas Eve, when it is a weekday and not the observed holiday
  const dec24 = daysFromCivil(y, 12, 24);
  const w24 = weekdayFromDays(dec24);
  if (w24 >= 1 && w24 <= 5 && !hol.has(dec24)) s.add(dec24);

  return s;
}

/* ── US Eastern time ─────────────────────────────────────────────────────── */

/** DST runs 2nd Sunday of March 07:00 UTC → 1st Sunday of November 06:00 UTC. */
export function isDST(ts: number): boolean {
  const { y } = civilFromDays(Math.floor(ts / SEC_PER_DAY));
  const start = nthWeekdayOfMonth(y, 3, 0, 2) * SEC_PER_DAY + 7 * 3600;
  const end = nthWeekdayOfMonth(y, 11, 0, 1) * SEC_PER_DAY + 6 * 3600;
  return ts >= start && ts < end;
}

/** Seconds to add to UTC to get wall-clock Eastern. −4h in DST, −5h otherwise. */
export function etOffset(ts: number): number {
  return isDST(ts) ? -4 * 3600 : -5 * 3600;
}

export const Session = {
  /** US equity regular session: arbitrage against the real stock is possible. */
  Open: 'open',
  /** Nights, weekends, holidays: the token trades but the underlying does not. */
  Closed: 'closed',
} as const;
export type Session = (typeof Session)[keyof typeof Session];

/**
 * The single source of truth for who owns the next stretch of return.
 *
 * `Open` means the NYSE regular session (09:30–16:00 ET, or 09:30–13:00 on a
 * scheduled early close). Everything else — pre-market, post-market, overnight,
 * weekends, holidays — is `Closed`, because those are precisely the hours in
 * which a tokenized share cannot be arbitraged against its underlying.
 */
export function sessionAt(ts: number): Session {
  const et = ts + etOffset(ts);
  const days = Math.floor(et / SEC_PER_DAY);
  const secOfDay = et - days * SEC_PER_DAY;

  const w = weekdayFromDays(days);
  if (w === 0 || w === 6) return Session.Closed;

  const { y } = civilFromDays(days);
  if (holidays(y).has(days)) return Session.Closed;

  const open = 9 * 3600 + 1800;                                   // 09:30 ET
  const close = earlyCloses(y).has(days) ? 13 * 3600 : 16 * 3600;  // 13:00 or 16:00 ET
  return secOfDay >= open && secOfDay < close ? Session.Open : Session.Closed;
}

/** The next instant at which `sessionAt` changes value, searched minute-wise. */
export function nextBoundary(ts: number, limitDays = 12): number | null {
  const cur = sessionAt(ts);
  const end = ts + limitDays * SEC_PER_DAY;
  // minute granularity is exact: every boundary lands on a whole minute
  let t = Math.floor(ts / 60) * 60 + 60;
  for (; t <= end; t += 60) if (sessionAt(t) !== cur) return t;
  return null;
}

export const isoDay = (days: number): string => {
  const { y, m, d } = civilFromDays(days);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};
