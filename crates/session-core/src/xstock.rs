//! What one raw atom of an xStock is worth.
//!
//! An xStock is a Token-2022 mint with the Scaled UI Amount extension:
//! `displayed = raw × multiplier`, and one *displayed* token is one share.
//! The multiplier grows as dividends are reinvested and jumps at a split. So
//! a raw whole token is worth `multiplier` shares, and one raw atom is worth
//!
//! ```text
//! X = share price × multiplier × 10^quote_decimals / 10^raw_decimals   (quote atoms)
//! ```
//!
//! xStocks' integrator documentation, Pyth's `.RR` feeds (NVDAX/NVDA.RR read
//! 1.00091807 against a multiplier of 1.0009180758) and real Jupiter fills
//! (a raw token costs `share × multiplier` plus the spread, not one share)
//! all agree on this. `docs/CROSS.md` has the evidence.
//!
//! The extension stores the multiplier as an IEEE-754 double. This module
//! converts it from its bits exactly, with integer arithmetic only: no float
//! operation runs on chain, so no two validators can disagree about a price.

use crate::fixed::{mul_div_floor, WAD};

/// Token-2022's extension type number for `ScaledUiAmountConfig`.
pub const EXT_SCALED_UI_AMOUNT: u16 = 25;

/// A multiplier from the bits of the `f64` Token-2022 stores, in WAD, rounded
/// down. `None` for anything that cannot be a multiplier: negative, zero,
/// subnormal, infinite, NaN, or outside `[2⁻²⁰, 2²⁰]`, about one millionth to
/// one million.
pub fn multiplier_wad(bits: u64) -> Option<u128> {
    if bits >> 63 != 0 {
        return None;
    }
    let exp = ((bits >> 52) & 0x7ff) as i32;
    if exp == 0 || exp == 0x7ff {
        return None;
    }
    let unbiased = exp - 1023;
    if !(-20..=20).contains(&unbiased) {
        return None;
    }
    // value = mantissa × 2^(exp − 1075), with the implicit leading one; within
    // the bounds above the power is always negative, so this is a right shift
    // of an exact product: mantissa < 2⁵³ and WAD < 2⁶⁰, so it fits in u128.
    let mantissa = (bits & ((1u64 << 52) - 1)) | (1u64 << 52);
    let shift = (1075 - exp) as u32;
    Some((mantissa as u128 * WAD) >> shift)
}

/// The multiplier in force at `t`: the scheduled one once its time has come.
/// This is the rule Token-2022 itself applies when it scales a balance.
pub fn multiplier_bits_at(current_bits: u64, new_bits: u64, new_effective_ts: i64, t: i64) -> u64 {
    if t >= new_effective_ts { new_bits } else { current_bits }
}

/// The price of one raw atom in quote atoms, WAD-scaled, rounded down, from a
/// share price given as a Pyth mantissa and exponent.
pub fn price_per_raw_wad(
    mantissa: i64,
    expo: i16,
    multiplier_wad: u128,
    quote_decimals: u8,
    raw_decimals: u8,
) -> Option<u128> {
    if mantissa <= 0 || multiplier_wad == 0 {
        return None;
    }
    let k = expo as i32 + quote_decimals as i32 - raw_decimals as i32;
    let x = if k >= 0 {
        (mantissa as u128)
            .checked_mul(10u128.checked_pow(k as u32)?)?
            .checked_mul(multiplier_wad)?
    } else {
        mul_div_floor(mantissa as u128, multiplier_wad, 10u128.checked_pow((-k) as u32)?)?
    };
    if x == 0 { None } else { Some(x) }
}

/// A Pyth share price in units of 10⁻⁸ USD, the unit an order's limit is
/// written in, rounded down. Exact for every exponent from −8 up, which
/// includes every US equity feed (−5).
pub fn price_e8(mantissa: i64, expo: i16) -> Option<u64> {
    if mantissa <= 0 {
        return None;
    }
    let k = expo as i32 + 8;
    let v = if k >= 0 {
        (mantissa as u128).checked_mul(10u128.checked_pow(k as u32)?)?
    } else {
        mantissa as u128 / 10u128.checked_pow((-k) as u32)?
    };
    u64::try_from(v).ok()
}

/// The multiplier configuration of a mint, read from its raw account bytes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ScaledUi {
    pub current_bits: u64,
    pub new_bits: u64,
    pub new_effective_ts: i64,
}

impl ScaledUi {
    pub fn bits_at(&self, t: i64) -> u64 {
        multiplier_bits_at(self.current_bits, self.new_bits, self.new_effective_ts, t)
    }
}

/// Byte layout of a Token-2022 mint: the 82-byte base, padding to the
/// 165-byte account length, one account-type byte, then type-length-value
/// extensions.
const ACCOUNT_LEN: usize = 165;
const TLV_START: usize = ACCOUNT_LEN + 1;
const ACCOUNT_TYPE_MINT: u8 = 1;

/// Find the Scaled UI Amount configuration in a Token-2022 mint's bytes.
/// `Ok(None)` for a mint without the extension, which prices at a multiplier
/// of one; `Err(())` for bytes that are not a well-formed mint.
///
/// `ScaledUiAmountConfig` is 56 bytes: authority 32, multiplier f64,
/// new_multiplier_effective_timestamp i64, new_multiplier f64.
pub fn scaled_ui(data: &[u8]) -> Result<Option<ScaledUi>, ()> {
    if data.len() <= TLV_START {
        return if data.len() >= 82 { Ok(None) } else { Err(()) };
    }
    if data[ACCOUNT_LEN] != ACCOUNT_TYPE_MINT {
        return Err(());
    }
    let u16_at = |at: usize| -> Result<u16, ()> {
        Ok(u16::from_le_bytes(data.get(at..at + 2).ok_or(())?.try_into().map_err(|_| ())?))
    };
    let mut at = TLV_START;
    while at + 4 <= data.len() {
        let ty = u16_at(at)?;
        let len = u16_at(at + 2)? as usize;
        if ty == 0 && len == 0 {
            break;
        }
        let body = at + 4;
        let end = body.checked_add(len).ok_or(())?;
        let d = data.get(body..end).ok_or(())?;
        if ty == EXT_SCALED_UI_AMOUNT {
            if len != 56 {
                return Err(());
            }
            let u64_at = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
            return Ok(Some(ScaledUi {
                current_bits: u64_at(32),
                new_effective_ts: u64_at(40) as i64,
                new_bits: u64_at(48),
            }));
        }
        at = end;
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bits(v: f64) -> u64 {
        v.to_bits()
    }

    /// Expected values are exact: floor(value of the double × 10¹⁸), from
    /// Python's `Fraction`, not from this code.
    #[test]
    fn converts_real_multipliers_exactly() {
        assert_eq!(multiplier_wad(0x3ff003c2ac1bf43f), Some(1_000_918_075_849_099_642)); // NVDAx, until 10 Sep
        assert_eq!(multiplier_wad(0x3ff006f7d589fea9), Some(1_001_701_196_801_074_056)); // NVDAx, from 10 Sep
        assert_eq!(multiplier_wad(0x3ff7c7352ddf365c), Some(1_486_134_700_000_000_030)); // a PreStock's
        assert_eq!(multiplier_wad(bits(1.0)), Some(WAD));
        assert_eq!(multiplier_wad(bits(2f64.powi(-20))), Some(953_674_316_406));
        assert_eq!(multiplier_wad(bits(2f64.powi(20))), Some(1_048_576 * WAD));
    }

    #[test]
    fn refuses_what_cannot_be_a_multiplier() {
        for v in [0.0, -1.0, f64::INFINITY, f64::NAN, f64::MIN_POSITIVE / 2.0, 2f64.powi(-21), 2f64.powi(21), -0.0] {
            assert_eq!(multiplier_wad(bits(v)), None, "{v}");
        }
    }

    #[test]
    fn the_scheduled_multiplier_applies_from_its_second() {
        let (a, b) = (bits(1.0009), bits(1.0017));
        assert_eq!(multiplier_bits_at(a, b, 1_789_000_200, 1_789_000_199), a);
        assert_eq!(multiplier_bits_at(a, b, 1_789_000_200, 1_789_000_200), b);
    }

    #[test]
    fn prices_a_raw_atom() {
        // NVDA at 224.06 (Pyth: 22406000 × 10⁻⁵), USDC 6 decimals, NVDAx 8,
        // multiplier 1.001701196801074: 2.2444117… USDC atoms per raw atom
        let m = multiplier_wad(0x3ff006f7d589fea9).unwrap();
        assert_eq!(price_per_raw_wad(22_406_000, -5, m, 6, 8), Some(2_244_411_701_552_486_529));
        // multiplier one, exponent −8: 224.06 × 10⁶ / 10⁸ = 2.2406
        assert_eq!(price_per_raw_wad(22_406_000_000, -8, WAD, 6, 8), Some(2_240_600_000_000_000_000));
        // a positive k: a 2-decimal quote token against a 0-decimal raw token
        assert_eq!(price_per_raw_wad(12_345, -2, WAD, 2, 0), Some(12_345 * WAD));
        assert_eq!(price_per_raw_wad(0, -5, WAD, 6, 8), None);
        assert_eq!(price_per_raw_wad(-1, -5, WAD, 6, 8), None);
        assert_eq!(price_per_raw_wad(1, -5, 0, 6, 8), None);
        assert_eq!(price_per_raw_wad(1, -30, 1, 6, 8), None, "rounds to nothing");
        assert_eq!(price_per_raw_wad(i64::MAX, 12, u128::MAX, 18, 0), None, "overflow is refused");
    }

    #[test]
    fn a_limit_is_in_1e8_dollars() {
        assert_eq!(price_e8(22_406_000, -5), Some(22_406_000_000));
        assert_eq!(price_e8(22_406_000_000, -8), Some(22_406_000_000));
        assert_eq!(price_e8(224_060_000_000_000, -12), Some(22_406_000_000));
        assert_eq!(price_e8(0, -5), None);
    }

    fn fixture(name: &str) -> Vec<u8> {
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string("../../tests/vectors/issuer-mints.json").unwrap()).unwrap();
        let b64 = doc[name]["base64"].as_str().unwrap();
        decode_b64(b64)
    }

    fn decode_b64(s: &str) -> Vec<u8> {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let (mut acc, mut n) = (0u32, 0);
        for c in s.bytes().filter(|c| *c != b'=') {
            acc = (acc << 6) | T.iter().position(|t| *t == c).unwrap() as u32;
            n += 6;
            if n >= 8 {
                n -= 8;
                out.push((acc >> n) as u8);
            }
        }
        out
    }

    /// The real NVDAx mint, captured from mainnet on 21 Sep 2026.
    #[test]
    fn reads_the_real_nvdax_mint() {
        let s = scaled_ui(&fixture("nvdax")).unwrap().unwrap();
        assert_eq!(s.current_bits, 0x3ff003c2ac1bf43f);
        assert_eq!(s.new_bits, 0x3ff006f7d589fea9);
        assert_eq!(s.new_effective_ts, 1_789_000_200); // 10 Sep 2026 00:30 UTC
        // at the 24 Sep close the September multiplier is the one in force
        assert_eq!(multiplier_wad(s.bits_at(1_790_280_000)), Some(1_001_701_196_801_074_056));
    }

    #[test]
    fn malformed_mints_are_refused() {
        let good = fixture("nvdax");
        assert!(scaled_ui(&good[..40]).is_err());
        let mut not_a_mint = good.clone();
        not_a_mint[165] = 2;
        assert!(scaled_ui(&not_a_mint).is_err());
        let mut cut = good.clone();
        cut.truncate(200);
        assert!(scaled_ui(&cut).is_err() || scaled_ui(&cut) == Ok(None));
        // a classic 82-byte mint has no extensions: multiplier one
        assert_eq!(scaled_ui(&good[..82]), Ok(None));
    }
}
