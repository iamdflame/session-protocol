//! Oracle handling.
//!
//! Three Pyth feeds do three different jobs here, and the protocol needs all of
//! them:
//!
//! | feed                     | job                                              |
//! |--------------------------|--------------------------------------------------|
//! | `Crypto.<SYM>X/USD`      | the mark for NAV — the vault holds the *token*    |
//! | `Equity.US.<SYM>/USD`    | session detector: it only publishes when the real |
//! |                          | market is open, so its staleness *is* the bell    |
//! | `Crypto.<SYM>X/<SYM>.RR` | the token-to-stock ratio, i.e. the basis itself   |
//!
//! The second is the interesting one. Rather than trusting a hardcoded calendar
//! alone, the program cross-checks it against whether the US equity feed is
//! actually publishing. A holiday nobody encoded, or a trading halt, makes the
//! feed go quiet — and the vault treats quiet as closed. The calendar can be
//! wrong in the safe direction only.

use crate::calendar::Session;
use crate::fixed::{mul_div_floor, WAD};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OracleError {
    /// Price was zero or negative. A mark like that is not a price.
    NonPositivePrice,
    /// The feed has not published recently enough to settle against.
    Stale,
    /// Pyth's confidence interval is too wide relative to the price. Pyth is the
    /// only major oracle that publishes its own uncertainty; refusing to settle
    /// when it is high is the entire reason to want that number.
    Uncertain,
    /// The move since the last boundary exceeds what the vault will accept
    /// without human review.
    MoveTooLarge,
    /// Exponent out of the range any real feed uses.
    BadExponent,
    /// The account is not a Pyth price update, or is truncated.
    WrongAccount,
    Malformed,
    Overflow,
}

#[derive(Clone, Copy, Debug)]
pub struct Guards {
    /// How old the mark may be at settlement.
    pub max_stale_secs: u32,
    /// Maximum `conf / price`, in basis points.
    pub max_conf_bps: u16,
    /// Maximum move versus the previous boundary, in basis points.
    pub max_move_bps: u16,
    /// How long the equity feed may be quiet before the session counts as shut.
    pub equity_quiet_secs: u32,
}

impl Default for Guards {
    fn default() -> Self {
        Self {
            max_stale_secs: 120,
            max_conf_bps: 100,        // 1% of price
            max_move_bps: 2_000,      // 20% between boundaries
            equity_quiet_secs: 900,   // 15 minutes of silence means closed
        }
    }
}

/// A Pyth price as it arrives on chain.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Quote {
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
    pub publish_time: i64,
}

/// Convert a Pyth quote into quote-atoms per underlying-atom, WAD-scaled.
///
/// Pyth prices a *whole* token in USD; the vault moves atoms. Getting this
/// conversion wrong by a factor of ten does not fail loudly — it silently
/// misprices every boundary, so the decimals are explicit arguments rather
/// than constants.
pub fn normalize(q: &Quote, underlying_decimals: u8, quote_decimals: u8) -> Result<u128, OracleError> {
    if q.price <= 0 {
        return Err(OracleError::NonPositivePrice);
    }
    if q.expo < -18 || q.expo > 12 {
        return Err(OracleError::BadExponent);
    }
    if underlying_decimals > 18 || quote_decimals > 18 {
        return Err(OracleError::BadExponent);
    }

    let price = q.price as u128;
    // mark = price * 10^expo * 10^quote_dec / 10^under_dec, in WAD
    let mut num_pow: i32 = q.expo + quote_decimals as i32;
    let mut den_pow: i32 = underlying_decimals as i32;
    if num_pow < 0 {
        den_pow -= num_pow;
        num_pow = 0;
    }
    let num = WAD
        .checked_mul(10u128.checked_pow(num_pow as u32).ok_or(OracleError::Overflow)?)
        .ok_or(OracleError::Overflow)?;
    let den = 10u128.checked_pow(den_pow as u32).ok_or(OracleError::Overflow)?;

    mul_div_floor(price, num, den).ok_or(OracleError::Overflow)
}

/// Validate a mark before it is allowed to move anybody's NAV.
pub fn check_mark(
    q: &Quote,
    now: i64,
    last_mark: u128,
    underlying_decimals: u8,
    quote_decimals: u8,
    g: &Guards,
) -> Result<u128, OracleError> {
    if now.saturating_sub(q.publish_time) > g.max_stale_secs as i64 {
        return Err(OracleError::Stale);
    }
    // conf is in the same units as price, so the ratio needs no normalisation
    if q.price <= 0 {
        return Err(OracleError::NonPositivePrice);
    }
    let conf_bps = mul_div_floor(q.conf as u128, 10_000, q.price as u128)
        .ok_or(OracleError::Overflow)?;
    if conf_bps > g.max_conf_bps as u128 {
        return Err(OracleError::Uncertain);
    }

    let mark = normalize(q, underlying_decimals, quote_decimals)?;

    if last_mark > 0 {
        let diff = if mark > last_mark { mark - last_mark } else { last_mark - mark };
        let move_bps = mul_div_floor(diff, 10_000, last_mark).ok_or(OracleError::Overflow)?;
        if move_bps > g.max_move_bps as u128 {
            return Err(OracleError::MoveTooLarge);
        }
    }
    Ok(mark)
}

/// The session the vault will act on.
///
/// The calendar proposes and the equity feed disposes. A calendar that says
/// "open" is only believed when the US equity feed is actually publishing;
/// otherwise the market is treated as shut. The asymmetry is deliberate: being
/// wrongly closed costs a boundary, being wrongly open misprices one.
pub fn effective_session(
    calendar: Session,
    equity_publish_time: i64,
    now: i64,
    g: &Guards,
) -> Session {
    match calendar {
        Session::Closed => Session::Closed,
        Session::Open => {
            let quiet = now.saturating_sub(equity_publish_time);
            if quiet > g.equity_quiet_secs as i64 { Session::Closed } else { Session::Open }
        }
    }
}


/* ── reading a Pyth price update account ─────────────────────────────────────
   The `pyth-solana-receiver-sdk` crate is deliberately not a dependency. Its
   current release pins anchor-lang 1.2.0 against this program's 0.31, and the
   last release that accepts 0.31 no longer compiles on current Rust. Rather
   than pin the whole program to a dependency's schedule on a path that decides
   who gets paid, the account is parsed here, explicitly and auditably.

   Layout, matching `PriceUpdateV2` in the receiver program:

       offset  size  field
            0     8  anchor discriminator
            8    32  write_authority: Pubkey
           40   1|2  verification_level  (borsh enum: Partial{u8} = 2 bytes, Full = 1)
            ..  32  price_message.feed_id
            ..   8  price_message.price: i64
            ..   8  price_message.conf: u64
            ..   4  price_message.exponent: i32
            ..   8  price_message.publish_time: i64
            ..   8  price_message.prev_publish_time: i64
            ..   8  price_message.ema_price: i64
            ..   8  price_message.ema_conf: u64
            ..   8  posted_slot: u64

   The verification level is a borsh enum and therefore *variable width*, so the
   price message cannot be read at a fixed offset. Parsing is sequential.
*/

/// `sha256("account:PriceUpdateV2")[..8]`.
pub const PRICE_UPDATE_V2_DISC: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

/// How thoroughly the Wormhole VAA behind this price was verified.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Verification {
    /// Only some guardian signatures were checked. The count is carried so a
    /// caller can insist on a minimum.
    Partial(u8),
    /// The full guardian set was verified.
    Full,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PriceUpdate {
    pub verification: Verification,
    pub feed_id: [u8; 32],
    pub quote: Quote,
    pub posted_slot: u64,
}

fn take<'a>(d: &'a [u8], at: &mut usize, n: usize) -> Result<&'a [u8], OracleError> {
    let end = at.checked_add(n).ok_or(OracleError::Malformed)?;
    let s = d.get(*at..end).ok_or(OracleError::Malformed)?;
    *at = end;
    Ok(s)
}

macro_rules! read_le {
    ($t:ty, $d:expr, $at:expr, $n:expr) => {{
        let b = take($d, $at, $n)?;
        let mut a = [0u8; $n];
        a.copy_from_slice(b);
        <$t>::from_le_bytes(a)
    }};
}

/// Parse a `PriceUpdateV2` account body.
///
/// Does not check the account owner — that is the caller's job, because only
/// the caller has the `AccountInfo`. Owner verification is not optional: without
/// it anyone could hand the program a look-alike account they wrote themselves.
pub fn parse_price_update(data: &[u8]) -> Result<PriceUpdate, OracleError> {
    let mut at = 0usize;
    let disc = take(data, &mut at, 8)?;
    if disc != PRICE_UPDATE_V2_DISC {
        return Err(OracleError::WrongAccount);
    }
    let _write_authority = take(data, &mut at, 32)?;

    let verification = match take(data, &mut at, 1)?[0] {
        0 => Verification::Partial(take(data, &mut at, 1)?[0]),
        1 => Verification::Full,
        _ => return Err(OracleError::Malformed),
    };

    let mut feed_id = [0u8; 32];
    feed_id.copy_from_slice(take(data, &mut at, 32)?);

    let price = read_le!(i64, data, &mut at, 8);
    let conf = read_le!(u64, data, &mut at, 8);
    let expo = read_le!(i32, data, &mut at, 4);
    let publish_time = read_le!(i64, data, &mut at, 8);
    let _prev_publish_time = read_le!(i64, data, &mut at, 8);
    let _ema_price = read_le!(i64, data, &mut at, 8);
    let _ema_conf = read_le!(u64, data, &mut at, 8);
    let posted_slot = read_le!(u64, data, &mut at, 8);

    Ok(PriceUpdate {
        verification,
        feed_id,
        quote: Quote { price, conf, expo, publish_time },
        posted_slot,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const G: Guards = Guards {
        max_stale_secs: 120,
        max_conf_bps: 100,
        max_move_bps: 2_000,
        equity_quiet_secs: 900,
    };

    /// NVDAx: 8 decimals, quoted in USDC with 6. At $220.34 one underlying atom
    /// is worth 2.2034 quote atoms.
    #[test]
    fn normalizes_a_real_xstock_quote() {
        let q = Quote { price: 22_034_000_000, conf: 5_000_000, expo: -8, publish_time: 0 };
        let mark = normalize(&q, 8, 6).unwrap();
        let expect = 2_203_400_000_000_000_000u128; // 2.2034 WAD
        assert_eq!(mark, expect, "got {mark}");
    }

    #[test]
    fn decimals_are_not_interchangeable() {
        let q = Quote { price: 22_034_000_000, conf: 0, expo: -8, publish_time: 0 };
        // same token priced against a 9-decimal quote asset is 1000x the atoms
        let a = normalize(&q, 8, 6).unwrap();
        let b = normalize(&q, 8, 9).unwrap();
        assert_eq!(b, a * 1000);
    }

    #[test]
    fn rejects_nonpositive_and_absurd_exponents() {
        let bad = Quote { price: 0, conf: 0, expo: -8, publish_time: 0 };
        assert_eq!(normalize(&bad, 8, 6), Err(OracleError::NonPositivePrice));
        let expo = Quote { price: 1, conf: 0, expo: -30, publish_time: 0 };
        assert_eq!(normalize(&expo, 8, 6), Err(OracleError::BadExponent));
    }

    #[test]
    fn stale_marks_are_refused() {
        let q = Quote { price: 22_034_000_000, conf: 1_000_000, expo: -8, publish_time: 1_000 };
        assert_eq!(check_mark(&q, 1_000 + 121, 0, 8, 6, &G), Err(OracleError::Stale));
        assert!(check_mark(&q, 1_000 + 119, 0, 8, 6, &G).is_ok());
    }

    #[test]
    fn wide_confidence_is_refused() {
        // 2% confidence against a 1% limit — exactly what the band is for
        let q = Quote { price: 10_000, conf: 200, expo: -8, publish_time: 0 };
        assert_eq!(check_mark(&q, 0, 0, 8, 6, &G), Err(OracleError::Uncertain));
        let ok = Quote { conf: 50, ..q };
        assert!(check_mark(&ok, 0, 0, 8, 6, &G).is_ok());
    }

    #[test]
    fn an_implausible_jump_is_refused() {
        let q = Quote { price: 22_034_000_000, conf: 0, expo: -8, publish_time: 0 };
        let mark = normalize(&q, 8, 6).unwrap();
        // previous boundary was half this price: a 100% move, over the 20% limit
        assert_eq!(check_mark(&q, 0, mark / 2, 8, 6, &G), Err(OracleError::MoveTooLarge));
        // a 10% move is fine
        assert!(check_mark(&q, 0, mark * 100 / 110, 8, 6, &G).is_ok());
    }


    /// Build a synthetic PriceUpdateV2 body the way the receiver program lays
    /// it out, so the parser is exercised against the real shape.
    fn encode_update(full: bool, feed: [u8; 32], price: i64, conf: u64, expo: i32, pt: i64) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&PRICE_UPDATE_V2_DISC);
        v.extend_from_slice(&[7u8; 32]);                 // write_authority
        if full { v.push(1); } else { v.extend_from_slice(&[0, 13]); }
        v.extend_from_slice(&feed);
        v.extend_from_slice(&price.to_le_bytes());
        v.extend_from_slice(&conf.to_le_bytes());
        v.extend_from_slice(&expo.to_le_bytes());
        v.extend_from_slice(&pt.to_le_bytes());
        v.extend_from_slice(&(pt - 1i64).to_le_bytes()); // prev_publish_time
        v.extend_from_slice(&price.to_le_bytes());       // ema_price
        v.extend_from_slice(&conf.to_le_bytes());        // ema_conf
        v.extend_from_slice(&42u64.to_le_bytes());       // posted_slot
        v
    }

    #[test]
    fn parses_both_verification_levels() {
        let feed = [9u8; 32];
        for full in [true, false] {
            let raw = encode_update(full, feed, 22_034_000_000, 5_000_000, -8, 1_700_000_000);
            let u = parse_price_update(&raw).unwrap();
            assert_eq!(u.feed_id, feed);
            assert_eq!(u.quote.price, 22_034_000_000);
            assert_eq!(u.quote.conf, 5_000_000);
            assert_eq!(u.quote.expo, -8);
            assert_eq!(u.quote.publish_time, 1_700_000_000);
            assert_eq!(u.posted_slot, 42);
            assert_eq!(u.verification, if full { Verification::Full } else { Verification::Partial(13) });
        }
    }

    #[test]
    fn a_partial_update_shifts_every_later_field_by_one_byte() {
        // the whole reason the parser is sequential rather than fixed-offset
        let feed = [3u8; 32];
        let a = encode_update(true, feed, 1_000, 1, -8, 55);
        let b = encode_update(false, feed, 1_000, 1, -8, 55);
        assert_eq!(b.len(), a.len() + 1);
        assert_eq!(parse_price_update(&a).unwrap().quote.publish_time, 55);
        assert_eq!(parse_price_update(&b).unwrap().quote.publish_time, 55);
    }

    #[test]
    fn rejects_foreign_and_truncated_accounts() {
        let feed = [1u8; 32];
        let mut raw = encode_update(true, feed, 1, 0, -8, 0);
        raw[0] ^= 0xff;
        assert_eq!(parse_price_update(&raw), Err(OracleError::WrongAccount));

        let short = encode_update(true, feed, 1, 0, -8, 0);
        assert_eq!(parse_price_update(&short[..40]), Err(OracleError::Malformed));
        assert_eq!(parse_price_update(&[]), Err(OracleError::Malformed));
    }

    #[test]
    fn a_quiet_equity_feed_closes_the_market() {
        let now = 1_000_000i64;
        // calendar says open and the feed is publishing: open
        assert_eq!(effective_session(Session::Open, now - 10, now, &G), Session::Open);
        // calendar says open but the feed went quiet: an unencoded holiday or a halt
        assert_eq!(effective_session(Session::Open, now - 1_000, now, &G), Session::Closed);
        // a live feed can never open a market the calendar says is shut
        assert_eq!(effective_session(Session::Closed, now, now, &G), Session::Closed);
    }
}
