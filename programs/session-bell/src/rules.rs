//! The bell rule, method v1: which Pyth Pro price *is* the open or the close.
//!
//! - **Close.** The last equity price Pyth generated in `[close − lead, close]`,
//!   where close is 16:00 ET, or 13:00 on the three scheduled half-days.
//! - **Open.** The first equity price Pyth generated in `[open, open + window]`,
//!   where open is 09:30 ET.
//!
//! In either case the price must be positive and come from the regular
//! session. It needs at least `min_publishers` publishers and a confidence
//! interval no wider than `max_conf_bps`. "Generated" means Pyth's
//! per-feed update timestamp, not the message's: since March 2026 a feed whose
//! market has shut carries its last price forward in every message, and a
//! 16:00:05 message can hold a 15:59:58 price. The window is judged on
//! when the price is *from*.
//!
//! Posting is open to anyone and improvements are monotone: a later close or
//! an earlier open replaces the stored one, and an equal or worse one is
//! refused. Pyth cannot sign a price it has not yet produced, so the best
//! candidate for a window only becomes available after that window has
//! passed. With one honest poster before the deadline, the stored print is
//! the rule's answer, whoever else posted first.
//!
//! This is Pyth's aggregate at the bell, not the exchange's official auction
//! print. `docs/METHOD.md` says how far apart those have been and how that is
//! measured.

use session_core::calendar::day_session_bounds;

use crate::lazer::{FeedUpdate, MarketSession};
use crate::state::{Params, Quote};

/// 2020-01-01 and 2200-01-01 as ET day numbers. Outside them the calendar is
/// unreviewed and the arithmetic has no reason to run.
pub const MIN_DAY: i64 = 18_262;
pub const MAX_DAY: i64 = 84_006;

/// Pyth exponents in practice run −12 to 0. This is the band a price can be
/// in without its decimal representation losing its meaning.
pub const MIN_EXPONENT: i16 = -18;
pub const MAX_EXPONENT: i16 = 12;

const US_PER_SEC: u64 = 1_000_000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Open,
    Close,
}

impl Kind {
    pub fn from_u8(v: u8) -> Option<Kind> {
        match v {
            0 => Some(Kind::Open),
            1 => Some(Kind::Close),
            _ => None,
        }
    }
    pub fn as_u8(self) -> u8 {
        match self {
            Kind::Open => 0,
            Kind::Close => 1,
        }
    }
}

/// The bell, in unix seconds, or `None` if that day has none: weekends,
/// NYSE holidays, and days outside `[MIN_DAY, MAX_DAY)`.
pub fn bell_ts(day: i64, kind: Kind) -> Option<i64> {
    if !(MIN_DAY..MAX_DAY).contains(&day) {
        return None;
    }
    let (open, close) = day_session_bounds(day)?;
    Some(match kind {
        Kind::Open => open,
        Kind::Close => close,
    })
}

/// Inclusive bounds, in microseconds, on the feed timestamp a candidate may
/// carry.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Window {
    pub start_us: u64,
    pub end_us: u64,
}

impl Window {
    pub fn contains(&self, ts_us: u64) -> bool {
        self.start_us <= ts_us && ts_us <= self.end_us
    }
}

/// `bell` comes from `bell_ts`, so it is a positive second well inside u64
/// microseconds; the parameters are bounded by `Params::valid`.
pub fn window(bell: i64, kind: Kind, p: &Params) -> Window {
    let bell_us = bell as u64 * US_PER_SEC;
    match kind {
        Kind::Close => Window {
            start_us: bell_us - p.close_lead_secs as u64 * US_PER_SEC,
            end_us: bell_us,
        },
        Kind::Open => Window {
            start_us: bell_us,
            end_us: bell_us + p.open_window_secs as u64 * US_PER_SEC,
        },
    }
}

/// Unix second at which posting stops and the print may be frozen:
/// `finalize_after_secs` past the window's last instant.
pub fn deadline(bell: i64, kind: Kind, p: &Params) -> i64 {
    let window_end = match kind {
        Kind::Close => bell,
        Kind::Open => bell + p.open_window_secs as i64,
    };
    window_end + p.finalize_after_secs as i64
}

/// Why a candidate is not the bell price.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Reject {
    /// The message lacks a property the rule reads.
    Missing(&'static str),
    NonPositivePrice,
    BadExponent,
    TooFewPublishers,
    NotRegularSession,
    ConfidenceTooWide,
    OutsideWindow,
    /// The feed claims to be newer than the message carrying it.
    FeedAfterMessage,
}

/// The equity feed as a print, or why it is not one.
pub fn accept(f: &FeedUpdate, message_ts_us: u64, w: Window, p: &Params) -> Result<Quote, Reject> {
    let price = f.price.ok_or(Reject::Missing("price"))?;
    if price <= 0 {
        return Err(Reject::NonPositivePrice);
    }
    let expo = f.exponent.ok_or(Reject::Missing("exponent"))?;
    if !(MIN_EXPONENT..=MAX_EXPONENT).contains(&expo) {
        return Err(Reject::BadExponent);
    }
    let publishers = f.publishers.ok_or(Reject::Missing("publisherCount"))?;
    if publishers < p.min_publishers {
        return Err(Reject::TooFewPublishers);
    }
    match f.session.ok_or(Reject::Missing("marketSession"))? {
        MarketSession::Regular => {}
        _ => return Err(Reject::NotRegularSession),
    }
    // Zero is Pyth's "none"; a negative interval is not an interval.
    let conf = f.confidence.filter(|c| *c > 0).ok_or(Reject::Missing("confidence"))?;
    if conf as i128 * 10_000 > p.max_conf_bps as i128 * price as i128 {
        return Err(Reject::ConfidenceTooWide);
    }
    let ts = f.feed_ts_us.ok_or(Reject::Missing("feedUpdateTimestamp"))?;
    if !w.contains(ts) {
        return Err(Reject::OutsideWindow);
    }
    if message_ts_us < ts {
        return Err(Reject::FeedAfterMessage);
    }
    Ok(Quote::from_feed(f))
}

/// Whether a candidate at `new_ts_us` replaces a stored print at `old_ts_us`.
/// Strict: an equal timestamp never replaces, so two posters holding the same
/// aggregate cannot flip the account between their copies.
pub fn better(kind: Kind, old_ts_us: u64, new_ts_us: u64) -> bool {
    match kind {
        Kind::Close => new_ts_us > old_ts_us,
        Kind::Open => new_ts_us < old_ts_us,
    }
}

/// How far the token traded from what it redeems for, in basis points,
/// truncated toward zero: `(token − equity × rr) / (equity × rr)`.
///
/// `None` unless all three legs carry a positive price, or if aligning their
/// exponents would overflow i128. No leg is rounded before the division.
pub fn divergence_bps(equity: &Quote, rr: &Quote, token: &Quote) -> Option<i64> {
    if !(equity.present && rr.present && token.present) {
        return None;
    }
    if equity.price <= 0 || rr.price <= 0 || token.price <= 0 {
        return None;
    }
    // token·10^et  vs  equity·rr·10^(ee+er): shift whichever side has the
    // larger exponent so both are integers at the same scale.
    let k = token.expo as i32 - equity.expo as i32 - rr.expo as i32;
    let fair = (equity.price as i128).checked_mul(rr.price as i128)?;
    let (tok, fair) = if k >= 0 {
        ((token.price as i128).checked_mul(10i128.checked_pow(k as u32)?)?, fair)
    } else {
        (token.price as i128, fair.checked_mul(10i128.checked_pow((-k) as u32)?)?)
    };
    let bps = tok.checked_sub(fair)?.checked_mul(10_000)?.checked_div(fair)?;
    i64::try_from(bps).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use session_core::calendar::{days_from_civil, SEC_PER_DAY};

    const P: Params = Params::V1;

    fn day(y: i64, m: i64, d: i64) -> i64 {
        days_from_civil(y, m, d)
    }

    /// Unix seconds for a UTC wall time.
    fn utc(y: i64, m: i64, d: i64, hh: i64, mm: i64) -> i64 {
        day(y, m, d) * SEC_PER_DAY + hh * 3600 + mm * 60
    }

    fn feed(ts_us: u64) -> FeedUpdate {
        FeedUpdate {
            feed_id: 1314,
            price: Some(22_406_000_000),
            confidence: Some(1_100_000),
            exponent: Some(-8),
            publishers: Some(9),
            session: Some(MarketSession::Regular),
            feed_ts_us: Some(ts_us),
            ..FeedUpdate::default()
        }
    }

    #[test]
    fn day_bounds_are_the_dates_they_claim() {
        assert_eq!(MIN_DAY, day(2020, 1, 1));
        assert_eq!(MAX_DAY, day(2200, 1, 1));
    }

    #[test]
    fn the_close_is_16_00_eastern_in_both_offsets() {
        // Thursday 24 September 2026, EDT: 16:00 ET = 20:00 UTC
        assert_eq!(bell_ts(day(2026, 9, 24), Kind::Close), Some(utc(2026, 9, 24, 20, 0)));
        assert_eq!(bell_ts(day(2026, 9, 24), Kind::Open), Some(utc(2026, 9, 24, 13, 30)));
        // Tuesday 15 December 2026, EST: 16:00 ET = 21:00 UTC
        assert_eq!(bell_ts(day(2026, 12, 15), Kind::Close), Some(utc(2026, 12, 15, 21, 0)));
        assert_eq!(bell_ts(day(2026, 12, 15), Kind::Open), Some(utc(2026, 12, 15, 14, 30)));
    }

    #[test]
    fn dst_changes_move_the_bell_in_utc_not_in_new_york() {
        // Friday before and Monday after the March 2026 change (8 March)
        assert_eq!(bell_ts(day(2026, 3, 6), Kind::Close), Some(utc(2026, 3, 6, 21, 0)));
        assert_eq!(bell_ts(day(2026, 3, 9), Kind::Close), Some(utc(2026, 3, 9, 20, 0)));
        // and around the November change (1 November 2026)
        assert_eq!(bell_ts(day(2026, 10, 30), Kind::Open), Some(utc(2026, 10, 30, 13, 30)));
        assert_eq!(bell_ts(day(2026, 11, 2), Kind::Open), Some(utc(2026, 11, 2, 14, 30)));
    }

    #[test]
    fn half_days_close_at_13_00() {
        // Friday after Thanksgiving 2026 (27 November), EST
        assert_eq!(bell_ts(day(2026, 11, 27), Kind::Close), Some(utc(2026, 11, 27, 18, 0)));
        assert_eq!(bell_ts(day(2026, 11, 27), Kind::Open), Some(utc(2026, 11, 27, 14, 30)));
        // Christmas Eve 2026 is a Thursday
        assert_eq!(bell_ts(day(2026, 12, 24), Kind::Close), Some(utc(2026, 12, 24, 18, 0)));
    }

    #[test]
    fn no_bell_on_weekends_holidays_or_outside_the_calendar() {
        assert_eq!(bell_ts(day(2026, 9, 26), Kind::Close), None, "Saturday");
        assert_eq!(bell_ts(day(2026, 9, 27), Kind::Open), None, "Sunday");
        assert_eq!(bell_ts(day(2026, 11, 26), Kind::Close), None, "Thanksgiving");
        assert_eq!(bell_ts(day(2026, 4, 3), Kind::Open), None, "Good Friday");
        assert_eq!(bell_ts(MIN_DAY - 1, Kind::Close), None);
        assert_eq!(bell_ts(MAX_DAY, Kind::Close), None);
        assert_eq!(bell_ts(i64::MIN, Kind::Close), None);
        assert_eq!(bell_ts(i64::MAX, Kind::Open), None);
    }

    #[test]
    fn windows_and_deadlines() {
        let close = utc(2026, 9, 24, 20, 0);
        let w = window(close, Kind::Close, &P);
        assert_eq!(w.end_us, close as u64 * 1_000_000);
        assert_eq!(w.start_us, (close - 10) as u64 * 1_000_000);
        assert_eq!(deadline(close, Kind::Close, &P), close + 300);

        let open = utc(2026, 9, 24, 13, 30);
        let w = window(open, Kind::Open, &P);
        assert_eq!(w.start_us, open as u64 * 1_000_000);
        assert_eq!(w.end_us, (open + 60) as u64 * 1_000_000);
        assert_eq!(deadline(open, Kind::Open, &P), open + 60 + 300);
    }

    #[test]
    fn a_close_one_microsecond_either_side_of_the_window() {
        let close = utc(2026, 9, 24, 20, 0);
        let w = window(close, Kind::Close, &P);
        let at = |ts| accept(&feed(ts), ts + 5_000, w, &P);
        assert!(at(w.end_us).is_ok(), "16:00:00.000000 itself is in");
        assert!(at(w.start_us).is_ok(), "15:59:50.000000 is in");
        assert_eq!(at(w.end_us + 1), Err(Reject::OutsideWindow));
        assert_eq!(at(w.start_us - 1), Err(Reject::OutsideWindow));
    }

    #[test]
    fn each_guard_fires_on_its_own() {
        let close = utc(2026, 9, 24, 20, 0);
        let w = window(close, Kind::Close, &P);
        let ts = w.end_us - 200_000;
        let ok = feed(ts);
        assert!(accept(&ok, ts, w, &P).is_ok());

        let cases: [(FeedUpdate, Reject); 12] = [
            (FeedUpdate { price: None, ..ok }, Reject::Missing("price")),
            (FeedUpdate { price: Some(-1), ..ok }, Reject::NonPositivePrice),
            (FeedUpdate { exponent: None, ..ok }, Reject::Missing("exponent")),
            (FeedUpdate { exponent: Some(-19), ..ok }, Reject::BadExponent),
            (FeedUpdate { publishers: None, ..ok }, Reject::Missing("publisherCount")),
            (FeedUpdate { publishers: Some(2), ..ok }, Reject::TooFewPublishers),
            (FeedUpdate { session: None, ..ok }, Reject::Missing("marketSession")),
            (FeedUpdate { session: Some(MarketSession::PostMarket), ..ok }, Reject::NotRegularSession),
            (FeedUpdate { confidence: None, ..ok }, Reject::Missing("confidence")),
            (FeedUpdate { confidence: Some(-5), ..ok }, Reject::Missing("confidence")),
            // 25 bps of 224.06 is 0.56015: one mantissa unit over the line fails
            (FeedUpdate { confidence: Some(56_015_001), ..ok }, Reject::ConfidenceTooWide),
            (FeedUpdate { feed_ts_us: None, ..ok }, Reject::Missing("feedUpdateTimestamp")),
        ];
        for (f, want) in cases {
            assert_eq!(accept(&f, ts, w, &P), Err(want), "{f:?}");
        }
        assert!(accept(&FeedUpdate { confidence: Some(56_015_000), ..ok }, ts, w, &P).is_ok(), "exactly 25 bps is in");
        assert_eq!(accept(&ok, ts - 1, w, &P), Err(Reject::FeedAfterMessage));
    }

    #[test]
    fn a_carried_forward_price_is_judged_by_when_it_is_from() {
        // A 16:00:05 message still carrying the 15:59:58 price: in the window,
        // because the price is from 15:59:58. The same price carried into a
        // 16:00:05 *feed* timestamp would not be.
        let close = utc(2026, 9, 24, 20, 0);
        let w = window(close, Kind::Close, &P);
        let from = (close - 2) as u64 * 1_000_000;
        let msg = (close + 5) as u64 * 1_000_000;
        assert!(accept(&feed(from), msg, w, &P).is_ok());
        assert_eq!(accept(&feed(msg), msg, w, &P), Err(Reject::OutsideWindow));
    }

    #[test]
    fn divergence() {
        let q = |price: i64, expo: i16| Quote { price, expo, present: true, ..Quote::default() };
        // NVDA 224.06, 1.0017 NVDA per NVDAx, NVDAx at 224.41: fair 224.440902
        let d = divergence_bps(&q(22_406_000_000, -8), &q(100_170_000, -8), &q(22_441_000_000, -8));
        assert_eq!(d, Some(-1), "224.41 against a fair 224.440902 is −1.38 bps, truncated toward zero");
        // exactly fair, in mixed exponents
        assert_eq!(divergence_bps(&q(10_000, -2), &q(2, 0), &q(200_000_000, -6)), Some(0));
        // a token 3% rich
        assert_eq!(divergence_bps(&q(100, 0), &q(1, 0), &q(103, 0)), Some(300));
        // a missing or non-positive leg is unknown, not zero
        assert_eq!(divergence_bps(&q(100, 0), &Quote::default(), &q(103, 0)), None);
        assert_eq!(divergence_bps(&q(100, 0), &q(0, 0), &q(103, 0)), None);
        // an exponent gap no i128 can hold is unknown, not a panic
        assert_eq!(divergence_bps(&q(i64::MAX, -18), &q(i64::MAX, -18), &q(1, 12)), None);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2000))]

        /// Replacement never moves away from the bell: after any sequence of
        /// accepted posts, the stored close is the latest candidate seen and
        /// the stored open the earliest, whatever order they arrived in.
        #[test]
        fn replacement_is_monotone(ts in proptest::collection::vec(0u64..10_000_000, 1..40), open in any::<bool>()) {
            let kind = if open { Kind::Open } else { Kind::Close };
            let mut stored = ts[0];
            for &t in &ts[1..] {
                if better(kind, stored, t) {
                    stored = t;
                }
            }
            let want = if open { *ts.iter().min().unwrap() } else { *ts.iter().max().unwrap() };
            prop_assert_eq!(stored, want);
        }

        /// Every trading day in range has an open strictly before its close,
        /// 6.5 hours apart or 3.5 on a half-day, and a close window that
        /// ends on the close.
        #[test]
        fn every_bell_is_well_formed(d in MIN_DAY..MAX_DAY) {
            if let (Some(o), Some(c)) = (bell_ts(d, Kind::Open), bell_ts(d, Kind::Close)) {
                prop_assert!(c - o == 6 * 3600 + 1800 || c - o == 3 * 3600 + 1800);
                let w = window(c, Kind::Close, &P);
                prop_assert_eq!(w.end_us, c as u64 * 1_000_000);
                prop_assert!(deadline(o, Kind::Open, &P) < c);
            } else {
                prop_assert!(bell_ts(d, Kind::Open).is_none() && bell_ts(d, Kind::Close).is_none());
            }
        }

        /// Hostile days never panic.
        #[test]
        fn any_day_is_safe(d in any::<i64>(), k in any::<bool>()) {
            let _ = bell_ts(d, if k { Kind::Open } else { Kind::Close });
        }

        /// Divergence never panics, whatever the legs.
        #[test]
        fn divergence_is_total(a in any::<i64>(), b in any::<i64>(), c in any::<i64>(),
                               x in any::<i16>(), y in any::<i16>(), z in any::<i16>()) {
            let q = |price, expo| Quote { price, expo, present: true, ..Quote::default() };
            let _ = divergence_bps(&q(a, x), &q(b, y), &q(c, z));
        }
    }
}
