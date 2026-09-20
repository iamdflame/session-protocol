//! Funding between the two share classes.
//!
//! This is where the protocol produces something that has never existed: a
//! price for the session premium.
//!
//! The two classes are counterparties. When they are balanced in size, every
//! boundary is a clean internal handoff and nothing touches a market. When they
//! are not, the vault has to trade the difference, and the crowded side is the
//! one causing that cost. So the crowded side pays the sparse side, exactly as
//! a perpetual pays to hold its mark to the index.
//!
//! The resulting rate is the market's answer to "what is a night worth?" —
//! a number nobody has been able to observe, because until tokenized equity
//! traded around the clock there was no way to take either side of it.

use crate::fixed::{mul_div_floor, WAD};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FundingParams {
    /// Sensitivity of the rate to skew, in basis points. 0 disables funding.
    pub k_bps: u32,
    /// Hard cap on the rate applied at any single boundary, in basis points.
    pub max_bps: u32,
}

impl FundingParams {
    pub const fn new(k_bps: u32, max_bps: u32) -> Self {
        Self { k_bps, max_bps }
    }
}

impl Default for FundingParams {
    /// 25% sensitivity, capped at 50bp per boundary. That is ~22%/month if a
    /// vault sits maximally lopsided through every bell (50bp x 2 boundaries x
    /// 22 trading days), which is a deliberately strong pull and not a gentle
    /// one — an earlier comment here said 2.5% and was wrong by a factor of
    /// nine. It is the rate a class pays to keep the other side interested; if
    /// book stays maximally lopsided, which is enough to pull it back.
    fn default() -> Self {
        Self { k_bps: 2_500, max_bps: 50 }
    }
}

/// Signed skew in WAD: +1.0 means all capital sits in NIGHT, −1.0 all in DAY.
pub fn skew_wad(value_night: u128, value_day: u128) -> i128 {
    let total = value_night.saturating_add(value_day);
    if total == 0 {
        return 0;
    }
    let diff = value_night as i128 - value_day as i128;
    let mag = diff.unsigned_abs();
    let s = mul_div_floor(mag, WAD, total).unwrap_or(0) as i128;
    if diff < 0 { -s } else { s }
}

/// Quote atoms transferred at this boundary. Positive means NIGHT pays DAY.
///
/// The transfer is sized against `min(night, day)` rather than the total, so a
/// class with no counterparty can never be charged: with nothing on the other
/// side there is no imbalance cost to compensate for, and an unmatched holder
/// simply earns their session.
pub fn funding_transfer(value_night: u128, value_day: u128, p: &FundingParams) -> i128 {
    if p.k_bps == 0 {
        return 0;
    }
    let skew = skew_wad(value_night, value_day);
    if skew == 0 {
        return 0;
    }

    // rate = clamp(k * skew, ±max), in WAD
    let rate_mag = mul_div_floor(skew.unsigned_abs(), p.k_bps as u128, 10_000).unwrap_or(0);
    let cap = mul_div_floor(WAD, p.max_bps as u128, 10_000).unwrap_or(0);
    let rate = rate_mag.min(cap);

    let base = value_night.min(value_day);
    let amount = mul_div_floor(base, rate, WAD).unwrap_or(0) as i128;
    if skew > 0 { amount } else { -amount }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const P: FundingParams = FundingParams::new(2_500, 50);

    #[test]
    fn balanced_book_pays_nothing() {
        assert_eq!(funding_transfer(1_000_000, 1_000_000, &P), 0);
    }

    #[test]
    fn crowded_side_pays() {
        // NIGHT is twice DAY, so NIGHT pays
        let t = funding_transfer(2_000_000, 1_000_000, &P);
        assert!(t > 0, "night should pay, got {t}");
        // and the mirror image is exactly opposite
        assert_eq!(funding_transfer(1_000_000, 2_000_000, &P), -t);
    }

    #[test]
    fn a_class_with_no_counterparty_is_never_charged() {
        assert_eq!(funding_transfer(5_000_000, 0, &P), 0);
        assert_eq!(funding_transfer(0, 5_000_000, &P), 0);
        assert_eq!(funding_transfer(0, 0, &P), 0);
    }

    #[test]
    fn rate_is_capped() {
        // maximally lopsided: skew ~1.0, k would give 25%, cap must bind at 50bp
        let night = 1_000_000_000u128;
        let day = 1u128;
        let t = funding_transfer(night, day, &P).unsigned_abs();
        let max = day * P.max_bps as u128 / 10_000;
        assert!(t <= max + 1, "transfer {t} exceeded cap {max}");
    }

    #[test]
    fn disabled_when_k_is_zero() {
        let off = FundingParams::new(0, 50);
        assert_eq!(funding_transfer(9_000_000, 1_000_000, &off), 0);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1500))]

        /// Funding never exceeds the smaller side — it cannot bankrupt a class.
        #[test]
        fn never_exceeds_the_smaller_side(n in 0u128..(1u128 << 60), d in 0u128..(1u128 << 60)) {
            let t = funding_transfer(n, d, &P).unsigned_abs();
            prop_assert!(t <= n.min(d));
        }

        /// Swapping the classes negates the transfer, with no drift.
        #[test]
        fn antisymmetric(n in 0u128..(1u128 << 60), d in 0u128..(1u128 << 60)) {
            prop_assert_eq!(funding_transfer(n, d, &P), -funding_transfer(d, n, &P));
        }

        /// Funding always flows from the larger side to the smaller one.
        #[test]
        fn flows_from_crowded_to_sparse(n in 1u128..(1u128 << 60), d in 1u128..(1u128 << 60)) {
            let t = funding_transfer(n, d, &P);
            if n > d { prop_assert!(t >= 0); }
            if d > n { prop_assert!(t <= 0); }
        }

        /// Skew is bounded and correctly signed.
        #[test]
        fn skew_is_bounded(n in 0u128..(1u128 << 70), d in 0u128..(1u128 << 70)) {
            let s = skew_wad(n, d);
            prop_assert!(s.unsigned_abs() <= WAD);
            if n > d { prop_assert!(s > 0 || n - d < 2); }
            if d > n { prop_assert!(s < 0 || d - n < 2); }
        }
    }
}
