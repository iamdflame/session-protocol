//! Fixed-point arithmetic for NAV accounting.
//!
//! Every quantity that decides who owns what is an integer here. A rounding
//! error in `mul_div` is not a cosmetic bug: it is value moving between the
//! NIGHT and DAY classes without anyone trading.
//!
//! Values are WAD-scaled (18 decimals) `u128`. `mul_div` is computed through a
//! full 256-bit intermediate, so `a * b` never overflows before the divide —
//! the naive `a * b / d` would wrap for perfectly ordinary NAV × price inputs.

/// 1.0 in WAD fixed point.
pub const WAD: u128 = 1_000_000_000_000_000_000;

const MASK64: u128 = u64::MAX as u128;

/// 128 × 128 → 256, as (high, low).
#[inline]
fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    let (a_lo, a_hi) = (a & MASK64, a >> 64);
    let (b_lo, b_hi) = (b & MASK64, b >> 64);

    let ll = a_lo * b_lo;
    let lh = a_lo * b_hi;
    let hl = a_hi * b_lo;
    let hh = a_hi * b_hi;

    // accumulate the two middle terms into the 64..192 bit window
    let (mid, carry1) = lh.overflowing_add(hl);
    let carry1 = if carry1 { 1u128 << 64 } else { 0 };

    let (lo, carry2) = ll.overflowing_add(mid << 64);
    let hi = hh + (mid >> 64) + carry1 + if carry2 { 1 } else { 0 };
    (hi, lo)
}

/// 256 ÷ 128 → 128, returning `None` on overflow or division by zero.
/// Shift-subtract long division; the fast path handles the common case where
/// the product already fits in 128 bits.
#[inline]
fn div_wide(hi: u128, lo: u128, d: u128) -> Option<u128> {
    if d == 0 {
        return None;
    }
    if hi == 0 {
        return Some(lo / d);
    }
    if hi >= d {
        return None; // quotient would exceed u128
    }

    let mut rem = hi;
    let mut quo: u128 = 0;
    let mut i = 128;
    while i > 0 {
        i -= 1;
        // rem = rem << 1 | bit i of lo
        let carry = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        if carry == 1 || rem >= d {
            rem = rem.wrapping_sub(d);
            quo |= 1 << i;
        }
    }
    Some(quo)
}

/// `a * b / d`, rounded toward zero, exact through 256 bits.
#[inline]
pub fn mul_div_floor(a: u128, b: u128, d: u128) -> Option<u128> {
    let (hi, lo) = mul_wide(a, b);
    div_wide(hi, lo, d)
}

/// `a * b / d`, rounded away from zero.
///
/// Rounding direction is a protocol decision, not a detail: value leaving a
/// class rounds up and value entering rounds down, so arithmetic can only ever
/// favour the vault, never drain it.
#[inline]
pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> Option<u128> {
    let q = mul_div_floor(a, b, d)?;
    let (hi, lo) = mul_wide(a, b);
    let (rh, rl) = mul_wide(q, d);
    if hi == rh && lo == rl { Some(q) } else { q.checked_add(1) }
}

/// `a * b` in WAD.
#[inline]
pub fn mul_wad(a: u128, b: u128) -> Option<u128> {
    mul_div_floor(a, b, WAD)
}

/// `a / b` in WAD.
#[inline]
pub fn div_wad(a: u128, b: u128) -> Option<u128> {
    mul_div_floor(a, WAD, b)
}

/// Absolute difference, which appears everywhere in skew and imbalance maths.
#[inline]
pub fn abs_diff(a: u128, b: u128) -> u128 {
    if a > b { a - b } else { b - a }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn mul_wide_against_native() {
        // where the product fits in u128, the wide multiply must agree exactly
        for (a, b) in [(0u128, 0u128), (1, 1), (u64::MAX as u128, u64::MAX as u128),
                       (WAD, WAD), (12345678901234567890, 987654321)] {
            let (hi, lo) = mul_wide(a, b);
            let want = a.checked_mul(b);
            if let Some(w) = want {
                assert_eq!(hi, 0, "hi should be empty for {a}*{b}");
                assert_eq!(lo, w, "lo mismatch for {a}*{b}");
            }
        }
    }

    #[test]
    fn survives_products_that_overflow_u128() {
        // NAV(1e21 WAD) * price(2.2e10) overflows a naive u128 multiply path
        let nav = 1_000 * WAD;
        let p1 = 22_000_000_000u128;
        let p0 = 21_000_000_000u128;
        let out = mul_div_floor(nav, p1, p0).expect("must not overflow");
        // ~4.76% gain
        assert!(out > nav && out < nav * 2);
        let ratio = out as f64 / nav as f64;
        assert!((ratio - 22.0 / 21.0).abs() < 1e-12, "ratio was {ratio}");
    }

    #[test]
    fn huge_operands() {
        let a = u128::MAX / 2;
        let b = 3u128;
        let d = 6u128;
        assert_eq!(mul_div_floor(a, b, d), Some(a / 2));
    }

    #[test]
    fn div_by_zero_is_none() {
        assert_eq!(mul_div_floor(1, 1, 0), None);
    }

    #[test]
    fn overflowing_quotient_is_none() {
        // (2^127 * 2^127) / 1 cannot fit in u128
        assert_eq!(mul_div_floor(1 << 127, 1 << 127, 1), None);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2000))]

        /// Against a 256-bit reference computed with u64 limbs via i128 chunks.
        #[test]
        fn mul_div_matches_reference(a in 0u128..(1u128 << 90),
                                     b in 0u128..(1u128 << 90),
                                     d in 1u128..(1u128 << 90)) {
            let got = mul_div_floor(a, b, d);
            // reference: exact big-integer arithmetic via string-free u128 pairs
            let (hi, lo) = mul_wide(a, b);
            let reference = div_wide(hi, lo, d);
            prop_assert_eq!(got, reference);
            if let Some(q) = got {
                // q*d <= a*b < (q+1)*d
                let (qh, ql) = mul_wide(q, d);
                prop_assert!(qh < hi || (qh == hi && ql <= lo));
                if let Some(q1) = q.checked_add(1) {
                    let (q1h, q1l) = mul_wide(q1, d);
                    prop_assert!(q1h > hi || (q1h == hi && q1l > lo));
                }
            }
        }

        /// Ceil is floor, or exactly one more when there is a remainder.
        #[test]
        fn ceil_is_floor_plus_remainder(a in 0u128..(1u128 << 80),
                                        b in 0u128..(1u128 << 80),
                                        d in 1u128..(1u128 << 80)) {
            let f = mul_div_floor(a, b, d).unwrap();
            let c = mul_div_ceil(a, b, d).unwrap();
            prop_assert!(c == f || c == f + 1);
        }

        /// Multiplying by one in WAD is the identity.
        #[test]
        fn wad_identity(a in 0u128..(1u128 << 100)) {
            prop_assert_eq!(mul_wad(a, WAD), Some(a));
        }

        /// A round trip through div then mul loses at most one unit.
        #[test]
        fn div_then_mul_roundtrip(a in 1u128..(1u128 << 70), b in 1u128..(1u128 << 70)) {
            let q = div_wad(a, b).unwrap();
            let back = mul_wad(q, b).unwrap();
            prop_assert!(abs_diff(back, a) <= b / WAD + 1);
        }
    }
}
