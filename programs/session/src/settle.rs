//! Boundary settlement.
//!
//! At every session boundary exactly one thing happens: the class that held the
//! stock stops holding it and the other class starts. The class that was exposed
//! keeps the return earned over the session just ended; the parked class earned
//! nothing, because it held quote.
//!
//! The creative core of the protocol is that this handoff is *internal*. A
//! day-holder wants to be flat at precisely the instant a night-holder wants to
//! be long. They are perfect counterparties, so the inventory changes owner at
//! the oracle mark without touching a market. Only the difference in size
//! between the two sides — `handoff_delta` — ever needs to trade.
//!
//! That is why this works here and not in a brokerage account. Harvesting the
//! session premium in TradFi means ~250 round trips a year and the spread eats
//! the edge. Here the round trip is a bookkeeping entry.

use crate::fixed::{mul_div_ceil, mul_div_floor, WAD};
use crate::funding::{funding_transfer, FundingParams};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ShareClass {
    /// Earns while the US equity market is closed: nights, weekends, holidays.
    Night,
    /// Earns during the NYSE regular session.
    Day,
}

impl ShareClass {
    pub fn other(self) -> Self {
        match self {
            ShareClass::Night => ShareClass::Day,
            ShareClass::Day => ShareClass::Night,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MathError {
    /// A mark of zero would make the NAV roll meaningless.
    ZeroMark,
    /// Fixed-point overflow. The instruction fails rather than wrapping.
    Overflow,
}

/// The accounting state a boundary operates on. Deliberately free of any chain
/// types so it can be property-tested and replayed against real price history.
#[derive(Clone, Copy, Debug)]
pub struct NavState {
    /// Share atoms outstanding.
    pub night_supply: u64,
    pub day_supply: u64,
    /// Quote atoms per share atom, WAD-scaled.
    pub night_nav: u128,
    pub day_nav: u128,
    /// Which class currently holds the underlying.
    pub exposed: ShareClass,
    /// Quote atoms per underlying atom at the previous boundary, WAD-scaled.
    pub last_mark: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub night_nav: u128,
    pub day_nav: u128,
    pub exposed: ShareClass,
    /// Quote atoms moved by funding. Positive means NIGHT paid DAY.
    pub funding: i128,
    /// Quote-atom value of underlying to buy (positive) or sell (negative)
    /// to re-point inventory at the newly exposed class. Zero when the book is
    /// balanced, which is the case the design is built for.
    pub handoff_delta: i128,
    pub value_night: u128,
    pub value_day: u128,
}

/// Quote-atom value of a class.
#[inline]
pub fn value_of(supply: u64, nav: u128) -> Option<u128> {
    mul_div_floor(supply as u128, nav, WAD)
}

/// Settle a boundary at `new_mark`.
///
/// Order matters and is not arbitrary:
///   1. roll the exposed class by the session's price move
///   2. transfer funding between the classes
///   3. flip exposure and size the handoff
///
/// Funding is applied *after* the roll so that it is charged on the size the
/// classes actually ended the session with, and *before* the flip so that the
/// handoff is sized on post-funding values and the vault is never left short.
pub fn settle(s: &NavState, new_mark: u128, fp: &FundingParams) -> Result<Settlement, MathError> {
    if s.last_mark == 0 || new_mark == 0 {
        return Err(MathError::ZeroMark);
    }

    // 1. the exposed class earns the session; the parked class earns nothing
    let (mut night_nav, mut day_nav) = (s.night_nav, s.day_nav);
    let rolled = |nav: u128| mul_div_floor(nav, new_mark, s.last_mark).ok_or(MathError::Overflow);
    match s.exposed {
        ShareClass::Night => night_nav = rolled(night_nav)?,
        ShareClass::Day => day_nav = rolled(day_nav)?,
    }

    // Values are derived for sizing funding. NAV stays the primary quantity:
    // round-tripping NAV through value and back would quantise it to the value's
    // resolution (~1e-6 for a million shares) and floor it, leaking a little from
    // holders at every single boundary. Over a year of boundaries that is a
    // systematic, one-directional drain.
    let value_night = value_of(s.night_supply, night_nav).ok_or(MathError::Overflow)?;
    let value_day = value_of(s.day_supply, day_nav).ok_or(MathError::Overflow)?;

    // 2. the crowded side compensates the sparse side, applied straight to NAV
    let funding = funding_transfer(value_night, value_day, fp);
    if funding != 0 {
        let t = funding.unsigned_abs();
        let (payer_supply, receiver_supply) = if funding > 0 {
            (s.night_supply, s.day_supply)
        } else {
            (s.day_supply, s.night_supply)
        };
        // Round against both parties so rounding can only ever leave dust in the
        // vault, never take it out.
        let pay = if payer_supply == 0 { 0 } else {
            mul_div_ceil(t, WAD, payer_supply as u128).ok_or(MathError::Overflow)?
        };
        let recv = if receiver_supply == 0 { 0 } else {
            mul_div_floor(t, WAD, receiver_supply as u128).ok_or(MathError::Overflow)?
        };
        if funding > 0 {
            night_nav = night_nav.saturating_sub(pay);
            day_nav = day_nav.saturating_add(recv);
        } else {
            day_nav = day_nav.saturating_sub(pay);
            night_nav = night_nav.saturating_add(recv);
        }
    }

    let value_night = value_of(s.night_supply, night_nav).ok_or(MathError::Overflow)?;
    let value_day = value_of(s.day_supply, day_nav).ok_or(MathError::Overflow)?;

    // 3. hand the inventory over; only the size difference has to trade
    let exposed = s.exposed.other();
    let (need, have) = match exposed {
        ShareClass::Night => (value_night, value_day),
        ShareClass::Day => (value_day, value_night),
    };
    let handoff_delta = need as i128 - have as i128;

    Ok(Settlement {
        night_nav,
        day_nav,
        exposed,
        funding,
        handoff_delta,
        value_night,
        value_day,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const OFF: FundingParams = FundingParams::new(0, 0);
    const ON: FundingParams = FundingParams::new(2_500, 50);

    fn state(ns: u64, ds: u64, exposed: ShareClass) -> NavState {
        NavState {
            night_supply: ns,
            day_supply: ds,
            night_nav: WAD,
            day_nav: WAD,
            exposed,
            last_mark: WAD,
        }
    }

    #[test]
    fn exposed_class_earns_the_session_and_parked_earns_nothing() {
        let s = state(1_000_000, 1_000_000, ShareClass::Night);
        // the market rose 10% while it was shut
        let out = settle(&s, WAD * 110 / 100, &OFF).unwrap();
        assert_eq!(out.night_nav, WAD * 110 / 100, "night should capture the move");
        assert_eq!(out.day_nav, WAD, "day held quote and must be untouched");
        assert_eq!(out.exposed, ShareClass::Day, "exposure flips at the boundary");
    }

    #[test]
    fn a_losing_session_is_borne_only_by_the_exposed_class() {
        let s = state(1_000_000, 1_000_000, ShareClass::Day);
        let out = settle(&s, WAD * 90 / 100, &OFF).unwrap();
        assert_eq!(out.day_nav, WAD * 90 / 100);
        assert_eq!(out.night_nav, WAD);
    }

    #[test]
    fn a_balanced_book_needs_no_trade_at_all() {
        // equal supplies, equal NAV, no price move: the handoff is pure bookkeeping
        let s = state(1_000_000, 1_000_000, ShareClass::Night);
        let out = settle(&s, WAD, &OFF).unwrap();
        assert_eq!(out.handoff_delta, 0, "a balanced book must not touch a market");
    }

    #[test]
    fn only_the_imbalance_trades() {
        // NIGHT holds 1.5x what DAY holds; at the flip DAY must be made whole
        let s = state(1_500_000, 1_000_000, ShareClass::Night);
        let out = settle(&s, WAD, &OFF).unwrap();
        // exposure moves to DAY, which needs 1_000_000 of stock while 1_500_000 is held
        assert_eq!(out.handoff_delta, -500_000, "should sell exactly the excess");
    }

    #[test]
    fn funding_moves_value_from_the_crowded_side() {
        let s = state(2_000_000, 1_000_000, ShareClass::Night);
        let out = settle(&s, WAD, &ON).unwrap();
        assert!(out.funding > 0, "night is crowded and should pay");
        assert!(out.night_nav < WAD, "payer's NAV falls");
        assert!(out.day_nav > WAD, "receiver's NAV rises");
    }

    #[test]
    fn zero_mark_is_rejected() {
        let s = state(1, 1, ShareClass::Night);
        assert_eq!(settle(&s, 0, &OFF), Err(MathError::ZeroMark));
        let bad = NavState { last_mark: 0, ..s };
        assert_eq!(settle(&bad, WAD, &OFF), Err(MathError::ZeroMark));
    }

    #[test]
    fn an_empty_class_does_not_break_settlement() {
        let s = state(1_000_000, 0, ShareClass::Night);
        let out = settle(&s, WAD * 105 / 100, &ON).unwrap();
        assert_eq!(out.funding, 0, "nobody to pay");
        assert_eq!(out.value_day, 0);
        // everything must be sold: the newly exposed class holds nothing
        assert_eq!(out.handoff_delta, -(out.value_night as i128));
    }

    /// Compounding many sessions must land exactly where the product of the
    /// session returns says it should — this is the whole promise of the token.
    #[test]
    fn night_compounds_only_night_returns() {
        let mut s = state(1_000_000, 1_000_000, ShareClass::Night);
        let mut mark = WAD;
        // The mark sequence is integer arithmetic and truncates, so the
        // expectation is accumulated from the marks actually used rather than
        // from idealised powers of 1.02.
        let (mut expect_night, mut expect_day) = (1.0f64, 1.0f64);
        for _ in 0..10 {
            let prev = mark;
            mark = mark * 102 / 100;                      // the market moved while shut
            expect_night *= mark as f64 / prev as f64;
            let out = settle(&s, mark, &OFF).unwrap();
            s = NavState { night_nav: out.night_nav, day_nav: out.day_nav,
                           exposed: out.exposed, last_mark: mark, ..s };

            let prev = mark;
            mark = mark * 99 / 100;                       // and fell during the session
            expect_day *= mark as f64 / prev as f64;
            let out = settle(&s, mark, &OFF).unwrap();
            s = NavState { night_nav: out.night_nav, day_nav: out.day_nav,
                           exposed: out.exposed, last_mark: mark, ..s };
        }
        let got_night = s.night_nav as f64 / WAD as f64;
        let got_day = s.day_nav as f64 / WAD as f64;
        // NAV precision must survive repeated boundaries, not decay through them
        assert!((got_night - expect_night).abs() < 1e-12, "night {got_night} vs {expect_night}");
        assert!((got_day - expect_day).abs() < 1e-12, "day {got_day} vs {expect_day}");
        // and the two classes genuinely diverged: night up, day down
        assert!(got_night > 1.2 && got_day < 0.91, "night {got_night} day {got_day}");
    }


    /// The SDK mirrors this function so keepers and interfaces can predict a
    /// boundary without an RPC round trip. If the two ever diverge, they quote
    /// numbers the chain will not produce.
    #[test]
    fn matches_typescript_vectors() {
        let raw = std::fs::read_to_string("../../tests/vectors/settle.json")
            .expect("run `node tests/gen-settle-vectors.ts` first");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let cases = v["cases"].as_array().unwrap();
        assert!(cases.len() > 500, "expected a substantial vector set");

        let u = |x: &serde_json::Value| -> u128 { x.as_str().unwrap().parse().unwrap() };
        let i = |x: &serde_json::Value| -> i128 { x.as_str().unwrap().parse().unwrap() };
        let cls = |x: &serde_json::Value| match x.as_str().unwrap() {
            "night" => ShareClass::Night,
            _ => ShareClass::Day,
        };

        for (n, c) in cases.iter().enumerate() {
            let inp = &c["in"];
            let st = NavState {
                night_supply: u(&inp["nightSupply"]) as u64,
                day_supply: u(&inp["daySupply"]) as u64,
                night_nav: u(&inp["nightNav"]),
                day_nav: u(&inp["dayNav"]),
                exposed: cls(&inp["exposed"]),
                last_mark: u(&inp["lastMark"]),
            };
            let fp = FundingParams {
                k_bps: u(&c["fp"]["kBps"]) as u32,
                max_bps: u(&c["fp"]["maxBps"]) as u32,
            };
            let got = settle(&st, u(&c["newMark"]), &fp)
                .unwrap_or_else(|e| panic!("case {n} failed: {e:?}"));
            let want = &c["out"];

            assert_eq!(got.night_nav, u(&want["nightNav"]), "case {n} night_nav");
            assert_eq!(got.day_nav, u(&want["dayNav"]), "case {n} day_nav");
            assert_eq!(got.exposed, cls(&want["exposed"]), "case {n} exposed");
            assert_eq!(got.funding, i(&want["funding"]), "case {n} funding");
            assert_eq!(got.handoff_delta, i(&want["handoffDelta"]), "case {n} handoff_delta");
            assert_eq!(got.value_night, u(&want["valueNight"]), "case {n} value_night");
            assert_eq!(got.value_day, u(&want["valueDay"]), "case {n} value_day");
        }
        println!("settlement agrees with the SDK on {} vectors", cases.len());
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2000))]

        /// THE invariant. Settlement may move value between classes but must
        /// never create or destroy any. Tolerance is one atom per class for
        /// floor division.
        #[test]
        fn settlement_conserves_total_value(
            ns in 0u64..1_000_000_000_000u64,
            ds in 0u64..1_000_000_000_000u64,
            nav_n in (WAD / 100)..(WAD * 100),
            nav_d in (WAD / 100)..(WAD * 100),
            p0 in (WAD / 1000)..(WAD * 1000),
            p1 in (WAD / 1000)..(WAD * 1000),
            night_first in any::<bool>(),
        ) {
            let exposed = if night_first { ShareClass::Night } else { ShareClass::Day };
            let s = NavState { night_supply: ns, day_supply: ds, night_nav: nav_n,
                               day_nav: nav_d, exposed, last_mark: p0 };

            // Roll the exposed class's NAV exactly as settlement does, then value
            // both classes. What this test is really asserting is that the two
            // steps after the roll — funding and the handoff — move value between
            // the classes without creating or destroying any.
            let rolled_nav = match exposed {
                ShareClass::Night => mul_div_floor(nav_n, p1, p0),
                ShareClass::Day => mul_div_floor(nav_d, p1, p0),
            };
            prop_assume!(rolled_nav.is_some());
            let expected_total = match exposed {
                ShareClass::Night => value_of(ns, rolled_nav.unwrap()).unwrap()
                                       .saturating_add(value_of(ds, nav_d).unwrap()),
                ShareClass::Day => value_of(ds, rolled_nav.unwrap()).unwrap()
                                     .saturating_add(value_of(ns, nav_n).unwrap()),
            };

            if let Ok(out) = settle(&s, p1, &ON) {
                let total = out.value_night.saturating_add(out.value_day);
                let drift = if total > expected_total { total - expected_total }
                            else { expected_total - total };
                // floor division can lose at most one atom per class
                prop_assert!(drift <= 4, "created/destroyed {drift} atoms");
            }
        }

        /// Funding is a transfer, never a leak.
        #[test]
        fn funding_is_zero_sum(
            ns in 1u64..1_000_000_000u64,
            ds in 1u64..1_000_000_000u64,
            p in (WAD / 10)..(WAD * 10),
        ) {
            let s = NavState { night_supply: ns, day_supply: ds, night_nav: WAD,
                               day_nav: WAD, exposed: ShareClass::Night, last_mark: WAD };
            let with = settle(&s, p, &ON).unwrap();
            let without = settle(&s, p, &OFF).unwrap();
            let tw = with.value_night.saturating_add(with.value_day);
            let to = without.value_night.saturating_add(without.value_day);
            let drift = if tw > to { tw - to } else { to - tw };
            prop_assert!(drift <= 4, "funding changed the total by {drift}");
        }

        /// Exposure alternates strictly. If it ever failed to flip, one class
        /// would earn two sessions in a row.
        #[test]
        fn exposure_always_flips(
            ns in 0u64..1_000_000u64, ds in 0u64..1_000_000u64,
            p in (WAD / 10)..(WAD * 10), night_first in any::<bool>(),
        ) {
            let exposed = if night_first { ShareClass::Night } else { ShareClass::Day };
            let s = NavState { night_supply: ns, day_supply: ds, night_nav: WAD,
                               day_nav: WAD, exposed, last_mark: WAD };
            let out = settle(&s, p, &ON).unwrap();
            prop_assert_eq!(out.exposed, exposed.other());
        }
    }
}
