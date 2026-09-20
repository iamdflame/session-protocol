//! NYSE session calendar.
//!
//! The most safety-critical pure function in the protocol: it decides when a
//! boundary fires, and therefore which token class earns the next stretch of
//! return. A disagreement with the off-chain side would silently move money
//! between NIGHT and DAY holders.
//!
//! This is a deliberate line-for-line port of `sdk/src/calendar.ts`. Both run
//! the same integer algorithms — no timezone database on either side, because a
//! tz database that updates underneath a deployed program is an unreviewed
//! change to who gets paid. `tests/vectors/calendar.json` pins the two together.

pub const SEC_PER_DAY: i64 = 86_400;

/// Howard Hinnant's days-from-civil. Exact for all years, no calendar tables.
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 }.div_euclid(400);
    let yoe = y - era * 400; // [0, 399]
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Howard Hinnant's civil-from-days.
pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

/// 0 = Sunday. Day 0 (1970-01-01) was a Thursday, hence the +4.
pub fn weekday_from_days(days: i64) -> i64 {
    (days.rem_euclid(7) + 4).rem_euclid(7)
}

/// Day number of the `n`th `dow` in a month (1-based `n`).
fn nth_weekday_of_month(y: i64, m: i64, dow: i64, n: i64) -> i64 {
    let first = days_from_civil(y, m, 1);
    let shift = (dow - weekday_from_days(first)).rem_euclid(7);
    first + shift + (n - 1) * 7
}

/// Day number of the last `dow` in a month.
fn last_weekday_of_month(y: i64, m: i64, dow: i64) -> i64 {
    let next_first = if m == 12 { days_from_civil(y + 1, 1, 1) } else { days_from_civil(y, m + 1, 1) };
    let last = next_first - 1;
    last - (weekday_from_days(last) - dow).rem_euclid(7)
}

/// Anonymous Gregorian computus. Good Friday is the only movable NYSE holiday.
pub fn easter_sunday(y: i64) -> i64 {
    let a = y % 19;
    let b = y / 100;
    let c = y % 100;
    let d = b / 4;
    let e = b % 4;
    let f = (b + 8) / 25;
    let g = (b - f + 1) / 3;
    let h = (19 * a + b - d - g + 15) % 30;
    let i = c / 4;
    let k = c % 4;
    let l = (32 + 2 * e + 2 * i - h - k) % 7;
    let mm = (a + 11 * h + 22 * l) / 451;
    let month = (h + l - 7 * mm + 114) / 31;
    let day = (h + l - 7 * mm + 114) % 31 + 1;
    days_from_civil(y, month, day)
}

/// Saturday holidays are observed the Friday before, Sunday ones the Monday after.
fn observed(days: i64) -> i64 {
    match weekday_from_days(days) {
        6 => days - 1,
        0 => days + 1,
        _ => days,
    }
}

/// The ten full-day NYSE closures in a calendar year.
pub fn holidays(y: i64) -> [i64; 10] {
    [
        observed(days_from_civil(y, 1, 1)),   // New Year's Day
        nth_weekday_of_month(y, 1, 1, 3),     // MLK — 3rd Mon Jan
        nth_weekday_of_month(y, 2, 1, 3),     // Presidents — 3rd Mon Feb
        easter_sunday(y) - 2,                 // Good Friday
        last_weekday_of_month(y, 5, 1),       // Memorial — last Mon May
        observed(days_from_civil(y, 6, 19)),  // Juneteenth
        observed(days_from_civil(y, 7, 4)),   // Independence Day
        nth_weekday_of_month(y, 9, 1, 1),     // Labor — 1st Mon Sep
        nth_weekday_of_month(y, 11, 4, 4),    // Thanksgiving — 4th Thu Nov
        observed(days_from_civil(y, 12, 25)), // Christmas
    ]
}

pub fn is_holiday(days: i64) -> bool {
    let (y, _, _) = civil_from_days(days);
    holidays(y).contains(&days)
}

/// Scheduled 13:00 ET early closes. At most three in a year.
pub fn early_closes(y: i64) -> [Option<i64>; 3] {
    let hol = holidays(y);

    // July 3, when it is a weekday and not itself the observed holiday
    let jul3 = days_from_civil(y, 7, 3);
    let w3 = weekday_from_days(jul3);
    let a = if (1..=5).contains(&w3) && !hol.contains(&jul3) { Some(jul3) } else { None };

    // Friday after Thanksgiving
    let b = Some(nth_weekday_of_month(y, 11, 4, 4) + 1);

    // Christmas Eve, when it is a weekday and not itself the observed holiday
    let dec24 = days_from_civil(y, 12, 24);
    let w24 = weekday_from_days(dec24);
    let c = if (1..=5).contains(&w24) && !hol.contains(&dec24) { Some(dec24) } else { None };

    [a, b, c]
}

pub fn is_early_close(days: i64) -> bool {
    let (y, _, _) = civil_from_days(days);
    early_closes(y).iter().any(|d| *d == Some(days))
}

/// DST runs 2nd Sunday of March 07:00 UTC → 1st Sunday of November 06:00 UTC.
pub fn is_dst(ts: i64) -> bool {
    let (y, _, _) = civil_from_days(ts.div_euclid(SEC_PER_DAY));
    let start = nth_weekday_of_month(y, 3, 0, 2) * SEC_PER_DAY + 7 * 3600;
    let end = nth_weekday_of_month(y, 11, 0, 1) * SEC_PER_DAY + 6 * 3600;
    ts >= start && ts < end
}

/// Seconds to add to UTC for wall-clock Eastern: −4h in DST, −5h otherwise.
pub fn et_offset(ts: i64) -> i64 {
    if is_dst(ts) { -4 * 3600 } else { -5 * 3600 }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Session {
    /// NYSE regular session: the token can be arbitraged against the real stock.
    Open,
    /// Nights, weekends, holidays: the token trades, the underlying does not.
    Closed,
}

/// The single source of truth for who owns the next stretch of return.
///
/// `Open` is the regular session only (09:30–16:00 ET, or 09:30–13:00 on a
/// scheduled early close). Pre-market, post-market, overnight, weekends and
/// holidays are all `Closed` — those are exactly the hours in which a tokenized
/// share cannot be arbitraged against its underlying, which is the entire
/// economic basis of the split.
pub fn session_at(ts: i64) -> Session {
    let et = ts + et_offset(ts);
    let days = et.div_euclid(SEC_PER_DAY);
    let sec_of_day = et - days * SEC_PER_DAY;

    let w = weekday_from_days(days);
    if w == 0 || w == 6 {
        return Session::Closed;
    }
    if is_holiday(days) {
        return Session::Closed;
    }

    let open = 9 * 3600 + 1800; // 09:30 ET
    let close = if is_early_close(days) { 13 * 3600 } else { 16 * 3600 };
    if sec_of_day >= open && sec_of_day < close { Session::Open } else { Session::Closed }
}


/* ── boundary arithmetic ─────────────────────────────────────────────────────
   `session_at` answers "what is true now". A vault also has to answer "how many
   boundaries have I missed", and it has to do that on chain, where scanning
   minute by minute is not affordable. These walk day by day instead.
*/

/// UTC instants of the open and close for an ET day number, or `None` if that
/// day is not a trading day.
pub fn day_session_bounds(day: i64) -> Option<(i64, i64)> {
    let w = weekday_from_days(day);
    if w == 0 || w == 6 || is_holiday(day) {
        return None;
    }
    let close_sec = if is_early_close(day) { 13 * 3600 } else { 16 * 3600 };

    // `day * SEC_PER_DAY + wall` is Eastern wall-clock expressed as if it were
    // UTC; subtracting the (negative) offset converts it to a real UTC instant.
    // DST flips at 02:00 local on a Sunday and trading days are weekdays, so a
    // midday probe is never ambiguous.
    let probe = day * SEC_PER_DAY + 12 * 3600 + 5 * 3600;
    let off = if is_dst(probe) { -4 * 3600 } else { -5 * 3600 };

    Some((
        day * SEC_PER_DAY + 9 * 3600 + 1800 - off,
        day * SEC_PER_DAY + close_sec - off,
    ))
}

/// The first instant strictly after `ts` at which `session_at` changes value.
///
/// Walks whole days rather than minutes: bounded by `max_days` so a corrupt
/// calendar can never spin. `None` means no boundary within that horizon, which
/// for a market that closes every weekday should be treated as a fault.
pub fn next_boundary(ts: i64, max_days: i64) -> Option<i64> {
    let here = session_at(ts);
    let start_day = (ts + et_offset(ts)).div_euclid(SEC_PER_DAY);

    for d in 0..=max_days {
        let day = start_day + d;
        let Some((open, close)) = day_session_bounds(day) else { continue };
        match here {
            // the next change is this session's close, if we are inside it
            Session::Open if ts < close && ts >= open => return Some(close),
            _ => {
                if open > ts {
                    return Some(open);
                }
                if close > ts {
                    return Some(close);
                }
            }
        }
    }
    None
}

/// How many session boundaries lie in `(from, to]`, capped at `cap`.
///
/// This is what tells a vault whether it is one boundary behind — recoverable —
/// or several, in which case the marks for the intermediate boundaries are gone
/// and settling now would pay an entire session to the wrong class.
pub fn boundaries_between(from: i64, to: i64, cap: u32) -> u32 {
    if to <= from {
        return 0;
    }
    let mut n = 0u32;
    let mut t = from;
    while n < cap {
        match next_boundary(t, 12) {
            Some(b) if b <= to => {
                n += 1;
                t = b;
            }
            _ => break,
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_date_roundtrip() {
        let mut z = -50_000i64;
        while z < 50_000 {
            let (y, m, d) = civil_from_days(z);
            assert_eq!(days_from_civil(y, m, d), z, "roundtrip failed at {z}");
            z += 37;
        }
    }

    #[test]
    fn easter_known_values() {
        for (y, m, d) in [(2024, 3, 31), (2025, 4, 20), (2026, 4, 5), (2027, 3, 28)] {
            assert_eq!(easter_sunday(y), days_from_civil(y, m, d), "easter {y}");
        }
    }

    #[test]
    fn nyse_2026_holidays() {
        // the published NYSE 2026 calendar
        let want = [
            (1, 1), (1, 19), (2, 16), (4, 3), (5, 25),
            (6, 19), (7, 3), (9, 7), (11, 26), (12, 25),
        ];
        let mut got = holidays(2026);
        got.sort_unstable();
        let mut exp: Vec<i64> = want.iter().map(|(m, d)| days_from_civil(2026, *m, *d)).collect();
        exp.sort_unstable();
        assert_eq!(got.to_vec(), exp);
    }

    #[test]
    fn session_edges() {
        // 2026-09-21 is a Monday; EDT, so ET = UTC-4
        let d = days_from_civil(2026, 9, 21) * SEC_PER_DAY;
        assert_eq!(session_at(d + (9 * 3600 + 29 * 60) + 4 * 3600), Session::Closed);
        assert_eq!(session_at(d + (9 * 3600 + 30 * 60) + 4 * 3600), Session::Open);
        assert_eq!(session_at(d + (15 * 3600 + 59 * 60) + 4 * 3600), Session::Open);
        assert_eq!(session_at(d + 16 * 3600 + 4 * 3600), Session::Closed);
    }


    #[test]
    fn next_boundary_agrees_with_a_brute_force_minute_scan() {
        // the cheap day-walking version must match the obvious slow one
        let start = days_from_civil(2026, 1, 1) * SEC_PER_DAY;
        let mut t = start;
        for _ in 0..600 {
            let fast = next_boundary(t, 12).expect("a boundary must exist");
            let here = session_at(t);
            let mut slow = t + 60 - (t % 60);
            while slow < t + 20 * SEC_PER_DAY && session_at(slow) == here {
                slow += 60;
            }
            assert_eq!(fast, slow, "disagreement walking from {t}");
            t = fast;
        }
    }

    #[test]
    fn boundaries_between_counts_a_missed_weekend() {
        // Fri 2026-09-18 12:00 ET, through Mon 12:00 ET.
        // Friday close and Monday open both elapse: two boundaries.
        let fri = days_from_civil(2026, 9, 18) * SEC_PER_DAY + 16 * 3600; // 12:00 EDT
        let mon = days_from_civil(2026, 9, 21) * SEC_PER_DAY + 16 * 3600;
        assert_eq!(boundaries_between(fri, mon, 16), 2);

        // within the same session there is none
        assert_eq!(boundaries_between(fri, fri + 3600, 16), 0);

        // exactly one: Friday midday to Friday 16:30 ET
        let fri_eve = days_from_civil(2026, 9, 18) * SEC_PER_DAY + 20 * 3600 + 1800;
        assert_eq!(boundaries_between(fri, fri_eve, 16), 1);
    }

    #[test]
    fn boundary_count_is_capped_so_a_long_outage_cannot_spin() {
        let t = days_from_civil(2026, 1, 2) * SEC_PER_DAY;
        assert_eq!(boundaries_between(t, t + 365 * SEC_PER_DAY, 8), 8);
    }

    #[test]
    fn a_holiday_is_skipped_when_walking_to_the_next_open() {
        // Thanksgiving 2026-11-26 is a Thursday; Wednesday's close should hand
        // over to a NIGHT that runs until Friday's open
        let wed_close = days_from_civil(2026, 11, 25) * SEC_PER_DAY + 21 * 3600; // 16:00 EST
        let nb = next_boundary(wed_close, 12).unwrap();
        let et_day = (nb + et_offset(nb)).div_euclid(SEC_PER_DAY);
        let (y, m, d) = civil_from_days(et_day);
        assert_eq!((y, m, d), (2026, 11, 27), "should skip Thanksgiving entirely");
    }

    /// The whole point of the shared vectors: Rust must reproduce TypeScript.
    #[test]
    fn matches_typescript_vectors() {
        let raw = std::fs::read_to_string("../../tests/vectors/calendar.json")
            .expect("run `node tests/gen-vectors.ts` first");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let cases = v["cases"].as_array().unwrap();
        assert!(cases.len() > 1000, "expected a substantial vector set");

        let mut checked = 0usize;
        for c in cases {
            let ts = c["ts"].as_i64().unwrap();
            let want = match c["session"].as_str().unwrap() {
                "open" => Session::Open,
                _ => Session::Closed,
            };
            assert_eq!(session_at(ts), want, "ts={ts} note={}", c["note"]);
            checked += 1;
        }
        println!("calendar agrees with TypeScript on {checked} vectors");
    }
}
