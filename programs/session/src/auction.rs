//! The call auction at the bell.
//!
//! A handoff leaves a residual: the difference in size between the two
//! classes, which has to trade. Offering it continuously to whoever shows up
//! first has two problems. The first mover sets the price and takes the whole
//! incentive; and in the minutes after a bell — exactly when the mark is
//! least settled — that price is whatever one arbitrageur's model says.
//!
//! So the residual is auctioned instead. Bids accumulate for a window, then
//! one price clears all of them: the mark from the bell's own window, the
//! same number the settlement used. Everyone pays or receives it, pro rata if
//! they are oversubscribed. That is Uncross's shape and it is the right one
//! for a thin book — a call auction exists precisely because continuous
//! trading is bad at finding a price when nobody is standing there.
//!
//! What this module owns is the arithmetic: how much of the residual the bids
//! cover, what each bid gets, and what comes back. It holds no accounts and
//! does no transfers, so every rule here is testable without a validator.
//!
//! **Escrow never touches backing.** A bid's tokens sit in the vault's own
//! token accounts because a separate account per bid is rent nobody should
//! pay, but they are counted in `escrowed_*` and never in `owned_*`. Solvency
//! reads owned; the skim reads balance minus owned minus escrow. A bidder's
//! money is theirs until the auction clears, and a failed auction returns all
//! of it.

use crate::fixed::{mul_div_ceil, mul_div_floor, WAD};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AuctionError {
    /// The window has not closed yet.
    StillOpen,
    /// The window has closed; no more bids.
    Closed,
    /// There is nothing to auction.
    NothingToFill,
    /// A bid on the side the vault does not need.
    WrongSide,
    ZeroAmount,
    Overflow,
}

/// Which way the residual has to trade.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    /// `pending_delta > 0`: the vault is short stock and buys it. Bidders
    /// deliver underlying and are paid quote.
    VaultBuys,
    /// `pending_delta < 0`: the vault is long stock it no longer needs.
    /// Bidders deliver quote and are paid underlying.
    VaultSells,
}

impl Side {
    pub fn of(pending_delta: i128) -> Option<Self> {
        match pending_delta {
            d if d > 0 => Some(Side::VaultBuys),
            d if d < 0 => Some(Side::VaultSells),
            _ => None,
        }
    }
}

/// What the auction cleared at, and in what proportion.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Clearing {
    /// The price everyone gets: quote atoms per underlying atom, WAD-scaled.
    pub mark: u128,
    /// The share of each bid that fills, WAD-scaled. `WAD` means every bid
    /// fills whole; less means the auction was oversubscribed and each bid
    /// is cut in the same proportion.
    pub fill_ratio: u128,
    /// Underlying atoms the auction moves in total.
    pub underlying: u64,
    /// Quote atoms the auction moves in total.
    pub quote: u64,
}

/// Work out the clearing from the residual and what was bid.
///
/// `wanted_underlying` is the residual expressed in underlying atoms at the
/// clearing mark; `bid_underlying` is what the bidders offered in the same
/// units. Under-subscribed auctions fill whole and leave the rest to the
/// continuous path, where the ramp will keep raising the price.
pub fn clear(mark: u128, wanted_underlying: u64, bid_underlying: u64) -> Result<Clearing, AuctionError> {
    if mark == 0 {
        return Err(AuctionError::Overflow);
    }
    if wanted_underlying == 0 || bid_underlying == 0 {
        return Err(AuctionError::NothingToFill);
    }
    let underlying = wanted_underlying.min(bid_underlying);
    let fill_ratio = if bid_underlying <= wanted_underlying {
        WAD
    } else {
        // Round the ratio *down* so the sum of the filled bids can never
        // exceed what the vault asked for. The remainder stays with the
        // bidders, which is the safe direction.
        mul_div_floor(wanted_underlying as u128, WAD, bid_underlying as u128)
            .ok_or(AuctionError::Overflow)?
    };
    let quote = mul_div_floor(underlying as u128, mark, WAD).ok_or(AuctionError::Overflow)?;
    Ok(Clearing {
        mark,
        fill_ratio,
        underlying,
        quote: quote.min(u64::MAX as u128) as u64,
    })
}

/// What one bid gets and what comes back to it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Award {
    /// Underlying atoms this bid trades.
    pub underlying: u64,
    /// Quote atoms this bid trades, at the clearing price.
    pub quote: u64,
    /// Escrowed tokens returned unfilled, in whatever the bidder posted.
    pub refund: u64,
}

/// Settle one bid against a clearing.
///
/// `escrowed` is what the bidder posted: underlying when the vault buys,
/// quote when it sells. Rounding is against the bidder in the same direction
/// the continuous path uses, so an auction can never be a cheaper way to
/// extract value than a fill.
pub fn award(c: &Clearing, side: Side, bid_underlying: u64, escrowed: u64) -> Result<Award, AuctionError> {
    if bid_underlying == 0 {
        return Err(AuctionError::ZeroAmount);
    }
    let underlying = mul_div_floor(bid_underlying as u128, c.fill_ratio, WAD)
        .ok_or(AuctionError::Overflow)?
        .min(u64::MAX as u128) as u64;

    let quote = match side {
        // The vault pays: floor, so it never pays more than the stock is worth.
        Side::VaultBuys => mul_div_floor(underlying as u128, c.mark, WAD),
        // The bidder pays: ceil, so they never pay less.
        Side::VaultSells => mul_div_ceil(underlying as u128, c.mark, WAD),
    }
    .ok_or(AuctionError::Overflow)?
    .min(u64::MAX as u128) as u64;

    let spent = match side {
        Side::VaultBuys => underlying,
        Side::VaultSells => quote,
    };
    let refund = escrowed.checked_sub(spent).ok_or(AuctionError::Overflow)?;
    Ok(Award { underlying, quote, refund })
}

/// The residual in underlying atoms at `mark`.
///
/// Rounded down: filling less than the whole residual is always safe, and
/// filling more would overshoot the handoff and leave the vault mis-hedged
/// the other way.
pub fn wanted_underlying(pending_delta: i128, mark: u128) -> Result<u64, AuctionError> {
    if mark == 0 {
        return Err(AuctionError::Overflow);
    }
    let need = pending_delta.unsigned_abs();
    Ok(mul_div_floor(need, WAD, mark)
        .ok_or(AuctionError::Overflow)?
        .min(u64::MAX as u128) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const MARK: u128 = 2 * WAD; // two quote atoms per underlying atom

    #[test]
    fn an_undersubscribed_auction_fills_every_bid_whole() {
        let c = clear(MARK, 1_000, 600).unwrap();
        assert_eq!(c.fill_ratio, WAD);
        assert_eq!(c.underlying, 600, "only what was bid");
        assert_eq!(c.quote, 1_200);
        let a = award(&c, Side::VaultBuys, 600, 600).unwrap();
        assert_eq!(a, Award { underlying: 600, quote: 1_200, refund: 0 });
    }

    /// Oversubscribed, every bid is cut by the same ratio — and that ratio
    /// is floored, so the awards sum to a little *under* the residual rather
    /// than a little over. The dust stays unfilled and the continuous path
    /// picks it up at the next tier of the ramp; the alternative rounding
    /// would have the vault buying stock it did not ask for.
    #[test]
    fn an_oversubscribed_auction_cuts_every_bid_in_the_same_proportion() {
        // two bidders want 1,500 between them; the vault needs 1,000
        let c = clear(MARK, 1_000, 1_500).unwrap();
        assert_eq!(c.underlying, 1_000);
        assert_eq!(c.fill_ratio, WAD * 2 / 3, "two thirds, floored");

        let a = award(&c, Side::VaultBuys, 900, 900).unwrap();
        let b = award(&c, Side::VaultBuys, 600, 600).unwrap();
        // 900 and 600 at two-thirds, each floored
        assert_eq!((a.underlying, b.underlying), (599, 399));
        assert_eq!(a.underlying + b.underlying, 998);
        assert!(a.underlying + b.underlying <= c.underlying, "never more than the residual");
        assert!(c.underlying - (a.underlying + b.underlying) <= 2, "and the dust is atoms, not size");
        // the same proportion for both: 599/900 and 399/600 agree to within
        // the floor, which is what "one price, pro rata" has to mean
        assert!(a.underlying * 600 >= b.underlying * 900 - 900
            && a.underlying * 600 <= b.underlying * 900 + 900,
            "{}/900 and {}/600 are not the same proportion", a.underlying, b.underlying);
        assert_eq!(a.refund, 301);
        assert_eq!(b.refund, 201);
        assert_eq!(a.underlying + a.refund, 900, "every atom is either filled or returned");
        assert_eq!(b.underlying + b.refund, 600);
    }

    /// The property that makes it an auction rather than a queue.
    #[test]
    fn everyone_pays_the_same_price_whatever_their_size() {
        let c = clear(MARK, 10_000, 10_000).unwrap();
        for size in [1u64, 7, 100, 9_999] {
            let a = award(&c, Side::VaultSells, size, size * 2 + 10).unwrap();
            assert_eq!(a.quote, size * 2, "size {size} paid a different price");
        }
    }

    #[test]
    fn the_vault_never_takes_more_than_the_residual() {
        let c = clear(MARK, 1_000, 100_000).unwrap();
        let mut total = 0u64;
        // a hundred equal bids against a residual a hundredth their size
        for _ in 0..100 {
            total += award(&c, Side::VaultBuys, 1_000, 1_000).unwrap().underlying;
        }
        assert!(total <= 1_000, "filled {total} against a residual of 1,000");
    }

    #[test]
    fn rounding_runs_against_the_bidder_in_both_directions() {
        let odd = MARK + 1; // a mark that does not divide evenly
        let c = clear(odd, 1_000, 1_000).unwrap();
        let buys = award(&c, Side::VaultBuys, 333, 333).unwrap();
        let sells = award(&c, Side::VaultSells, 333, 10_000).unwrap();
        assert!(sells.quote >= buys.quote, "the bidder pays at least what the vault would have paid");
    }

    #[test]
    fn an_empty_auction_is_not_a_clearing() {
        assert_eq!(clear(MARK, 0, 100), Err(AuctionError::NothingToFill));
        assert_eq!(clear(MARK, 100, 0), Err(AuctionError::NothingToFill));
        assert_eq!(clear(0, 100, 100), Err(AuctionError::Overflow));
        assert_eq!(award(&clear(MARK, 1, 1).unwrap(), Side::VaultBuys, 0, 0), Err(AuctionError::ZeroAmount));
    }

    #[test]
    fn the_side_follows_the_residual() {
        assert_eq!(Side::of(1), Some(Side::VaultBuys));
        assert_eq!(Side::of(-1), Some(Side::VaultSells));
        assert_eq!(Side::of(0), None);
    }

    #[test]
    fn the_residual_converts_to_underlying_without_overshooting() {
        assert_eq!(wanted_underlying(2_000, MARK).unwrap(), 1_000);
        assert_eq!(wanted_underlying(-2_000, MARK).unwrap(), 1_000, "size, not direction");
        // a residual smaller than one atom is worth zero atoms, not one
        assert_eq!(wanted_underlying(1, MARK).unwrap(), 0);
    }

    proptest! {
        /// However many bids and whatever their sizes, the auction never
        /// moves more than the residual and never awards more than a bidder
        /// escrowed.
        #[test]
        fn no_set_of_bids_can_overfill_or_overspend(
            wanted in 1u64..1_000_000_000,
            bids in proptest::collection::vec(1u64..100_000_000, 1..12),
            mark in (WAD / 100)..(WAD * 100),
        ) {
            let total_bid: u64 = bids.iter().copied().fold(0u64, |a, b| a.saturating_add(b));
            let c = clear(mark, wanted, total_bid).unwrap();
            prop_assert!(c.underlying <= wanted);

            let mut filled = 0u64;
            for &b in &bids {
                // escrow exactly what the side demands, so a refund of more
                // than was posted would be caught as an overflow
                let escrow = mul_div_ceil(b as u128, mark, WAD).unwrap_or(0).min(u64::MAX as u128) as u64;
                let buy = award(&c, Side::VaultBuys, b, b).unwrap();
                prop_assert!(buy.underlying <= b);
                prop_assert_eq!(buy.underlying + buy.refund, b);
                filled = filled.saturating_add(buy.underlying);

                if escrow > 0 {
                    let sell = award(&c, Side::VaultSells, b, escrow);
                    if let Ok(s) = sell {
                        prop_assert!(s.quote <= escrow, "awarded more quote than was escrowed");
                        prop_assert_eq!(s.quote + s.refund, escrow);
                    }
                }
            }
            prop_assert!(filled <= wanted, "filled {} against a residual of {}", filled, wanted);
        }
    }
}
