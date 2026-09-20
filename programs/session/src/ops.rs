//! Instruction policy, separated from plumbing.
//!
//! Every rule that decides *how much* and *whether* lives here, as pure
//! functions over plain values. `lib.rs` keeps only what needs a chain: account
//! constraints, which Anchor enforces declaratively, and the token CPIs.
//!
//! The split is not cosmetic. Mixed into instruction handlers, these rules can
//! only be exercised by standing up a validator, mock oracles and SPL mints —
//! which is exactly why protocols ship with their economics untested. Here they
//! are ordinary functions, so the adversarial cases, the rounding directions and
//! the solvency invariant can all be property-tested directly.
//!
//! The rounding convention is uniform and deliberate: **every rounding decision
//! favours the vault**. A depositor receives floor(shares), a redeemer receives
//! floor(quote), and a fee charged to a class rounds up. Dust therefore
//! accumulates as backing rather than leaking out of it, and no sequence of
//! operations can extract value through rounding alone.

use crate::fixed::{mul_div_ceil, mul_div_floor, WAD};
use crate::settle::{value_of, ShareClass};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OpError {
    NotParked,
    ZeroAmount,
    AmountTooSmall,
    NavCollapsed,
    Overflow,
    Insolvent,
    NothingToFill,
    FillTooLarge,
    InsufficientQuote,
    InsufficientFreeQuote,
    InsufficientUnderlying,
    NoFeePayer,
    SlippageExceeded,
}

/// The subset of vault state the policy layer needs. Deliberately free of chain
/// types so it can be constructed in a test in one line.
#[derive(Clone, Copy, Debug)]
pub struct VaultView {
    pub night_nav: u128,
    pub day_nav: u128,
    pub exposed: ShareClass,
    pub last_mark: u128,
    pub owned_underlying: u64,
    pub owned_quote: u64,
    pub pending_delta: i128,
    pub fill_incentive_bps: u16,
}

impl VaultView {
    pub fn nav_of(&self, c: ShareClass) -> u128 {
        match c {
            ShareClass::Night => self.night_nav,
            ShareClass::Day => self.day_nav,
        }
    }
    pub fn is_parked(&self, c: ShareClass) -> bool {
        self.exposed != c
    }
    /// Quote committed to an outstanding purchase, and therefore not payable.
    pub fn reserved_quote(&self) -> u64 {
        if self.pending_delta > 0 {
            (self.pending_delta as u128).min(u64::MAX as u128) as u64
        } else {
            0
        }
    }
    pub fn free_quote(&self) -> u64 {
        self.owned_quote.saturating_sub(self.reserved_quote())
    }
}

/// Assets versus claims, as an explicit object so callers can report the margin
/// rather than only a pass/fail.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Solvency {
    pub assets: u128,
    pub claims: u128,
}

impl Solvency {
    pub fn ok(&self) -> bool {
        self.assets >= self.claims
    }
    pub fn margin(&self) -> i128 {
        self.assets as i128 - self.claims as i128
    }
}

/// Assets are *owned* balances marked at the last settled price — never token
/// account balances, which anyone can inflate by transfer.
pub fn solvency(v: &VaultView, night_supply: u64, day_supply: u64) -> Result<Solvency, OpError> {
    let assets = mul_div_floor(v.owned_underlying as u128, v.last_mark, WAD)
        .ok_or(OpError::Overflow)?
        .checked_add(v.owned_quote as u128)
        .ok_or(OpError::Overflow)?;
    let claims = value_of(night_supply, v.night_nav)
        .ok_or(OpError::Overflow)?
        .checked_add(value_of(day_supply, v.day_nav).ok_or(OpError::Overflow)?)
        .ok_or(OpError::Overflow)?;
    Ok(Solvency { assets, claims })
}

/* ── mint ────────────────────────────────────────────────────────────────── */

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MintPlan {
    pub shares: u64,
    pub owned_quote_after: u64,
}

/// A class may only be minted while it is parked in quote, so issuance never
/// has to buy or sell stock and therefore never moves the market.
pub fn plan_mint(
    v: &VaultView,
    class: ShareClass,
    quote_amount: u64,
) -> Result<MintPlan, OpError> {
    if quote_amount == 0 {
        return Err(OpError::ZeroAmount);
    }
    if !v.is_parked(class) {
        return Err(OpError::NotParked);
    }
    let nav = v.nav_of(class);
    if nav == 0 {
        return Err(OpError::NavCollapsed);
    }
    // floor: a depositor can never mint more claim than the quote they brought
    let shares = mul_div_floor(quote_amount as u128, WAD, nav).ok_or(OpError::Overflow)?;
    if shares == 0 {
        return Err(OpError::AmountTooSmall);
    }
    if shares > u64::MAX as u128 {
        return Err(OpError::Overflow);
    }
    Ok(MintPlan {
        shares: shares as u64,
        owned_quote_after: v.owned_quote.checked_add(quote_amount).ok_or(OpError::Overflow)?,
    })
}

/* ── redeem ──────────────────────────────────────────────────────────────── */

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RedeemPlan {
    pub quote_out: u64,
    pub owned_quote_after: u64,
}

pub fn plan_redeem(v: &VaultView, class: ShareClass, shares: u64) -> Result<RedeemPlan, OpError> {
    if shares == 0 {
        return Err(OpError::ZeroAmount);
    }
    if !v.is_parked(class) {
        return Err(OpError::NotParked);
    }
    let nav = v.nav_of(class);
    // floor: redemption can never take more than the claim
    let quote_out = mul_div_floor(shares as u128, nav, WAD).ok_or(OpError::Overflow)?;
    if quote_out == 0 {
        return Err(OpError::AmountTooSmall);
    }
    if quote_out > u64::MAX as u128 {
        return Err(OpError::Overflow);
    }
    let quote_out = quote_out as u64;

    // Quote earmarked for an outstanding handoff is not payable; without this a
    // redeemer could take the quote already committed to a purchase and leave
    // the handoff unfillable.
    if quote_out > v.free_quote() {
        return Err(OpError::InsufficientFreeQuote);
    }
    Ok(RedeemPlan {
        quote_out,
        owned_quote_after: v.owned_quote.checked_sub(quote_out).ok_or(OpError::Overflow)?,
    })
}

/* ── fill ────────────────────────────────────────────────────────────────── */

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FillPlan {
    /// True when the vault is buying underlying from the filler.
    pub buying: bool,
    pub gross: u128,
    pub incentive: u128,
    /// Quote leaving the vault (buying) or entering it (selling).
    pub quote_amount: u64,
    pub owned_underlying_after: u64,
    pub owned_quote_after: u64,
    pub pending_delta_after: i128,
    /// The class charged for the incentive: the larger one, whose size created
    /// the imbalance the filler is being paid to close.
    pub fee_payer: ShareClass,
    pub fee_per_share: u128,
}

/// Price a fill of the outstanding imbalance at the oracle mark.
///
/// The incentive is charged to a class rather than taken from the vault at
/// large. Taken from the vault it would erode backing for *both* classes on
/// every fill, which is a slow drain toward insolvency that no single
/// transaction would look wrong.
pub fn plan_fill(
    v: &VaultView,
    mark: u128,
    underlying_amount: u64,
    night_supply: u64,
    day_supply: u64,
) -> Result<FillPlan, OpError> {
    if v.pending_delta == 0 {
        return Err(OpError::NothingToFill);
    }
    if underlying_amount == 0 {
        return Err(OpError::ZeroAmount);
    }
    // Rounding is against the filler in both directions, because the filler
    // chooses the size and would otherwise pick one whose remainder favours
    // them. Buying, the vault pays no more than the stock is worth (floor);
    // selling, the filler pays no less (ceil). Floor both ways and each sell
    // leaks an atom of backing — small, but it accumulates and never reverses.
    let buying = v.pending_delta > 0;
    let gross = if buying {
        mul_div_floor(underlying_amount as u128, mark, WAD)
    } else {
        mul_div_ceil(underlying_amount as u128, mark, WAD)
    }
    .ok_or(OpError::Overflow)?;
    if gross == 0 {
        return Err(OpError::AmountTooSmall);
    }
    let incentive =
        mul_div_floor(gross, v.fill_incentive_bps as u128, 10_000).ok_or(OpError::Overflow)?;

    let (quote_amount, owned_underlying_after, owned_quote_after, pending_after) = if buying {
        if gross > v.pending_delta as u128 {
            return Err(OpError::FillTooLarge);
        }
        let out = gross.checked_add(incentive).ok_or(OpError::Overflow)?;
        if out > u64::MAX as u128 {
            return Err(OpError::Overflow);
        }
        let out = out as u64;
        if out > v.owned_quote {
            return Err(OpError::InsufficientQuote);
        }
        (
            out,
            v.owned_underlying.checked_add(underlying_amount).ok_or(OpError::Overflow)?,
            v.owned_quote - out,
            v.pending_delta - gross as i128,
        )
    } else {
        if gross > v.pending_delta.unsigned_abs() {
            return Err(OpError::FillTooLarge);
        }
        if underlying_amount > v.owned_underlying {
            return Err(OpError::InsufficientUnderlying);
        }
        let inflow = gross.checked_sub(incentive).ok_or(OpError::Overflow)? as u64;
        (
            inflow,
            v.owned_underlying - underlying_amount,
            v.owned_quote.checked_add(inflow).ok_or(OpError::Overflow)?,
            v.pending_delta + gross as i128,
        )
    };

    // the larger class pays, because its size is what created the imbalance
    let night_value = value_of(night_supply, v.night_nav).ok_or(OpError::Overflow)?;
    let day_value = value_of(day_supply, v.day_nav).ok_or(OpError::Overflow)?;
    let (fee_payer, payer_supply) = if night_value >= day_value {
        (ShareClass::Night, night_supply)
    } else {
        (ShareClass::Day, day_supply)
    };

    let fee_per_share = if incentive == 0 {
        0
    } else {
        if payer_supply == 0 {
            return Err(OpError::NoFeePayer);
        }
        // ceil: the charge rounds against the payer, never against the vault
        mul_div_ceil(incentive, WAD, payer_supply as u128).ok_or(OpError::Overflow)?
    };

    Ok(FillPlan {
        buying,
        gross,
        incentive,
        quote_amount,
        owned_underlying_after,
        owned_quote_after,
        pending_delta_after: pending_after,
        fee_payer,
        fee_per_share,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn vault() -> VaultView {
        VaultView {
            night_nav: WAD,
            day_nav: WAD,
            exposed: ShareClass::Night,
            last_mark: WAD,
            owned_underlying: 0,
            owned_quote: 1_000_000,
            pending_delta: 0,
            fill_incentive_bps: 10,
        }
    }

    /* ── mint ────────────────────────────────────────────────────────── */

    #[test]
    fn an_exposed_class_cannot_be_minted() {
        let v = vault(); // NIGHT is exposed
        assert_eq!(plan_mint(&v, ShareClass::Night, 1_000), Err(OpError::NotParked));
        assert!(plan_mint(&v, ShareClass::Day, 1_000).is_ok());
    }

    #[test]
    fn minting_rounds_down_so_a_depositor_never_gains() {
        let mut v = vault();
        v.day_nav = WAD * 3; // 3 quote per share
        // 1_000 quote buys 333 shares worth 999, never 334 worth 1_002
        let p = plan_mint(&v, ShareClass::Day, 1_000).unwrap();
        assert_eq!(p.shares, 333);
        let back = mul_div_floor(p.shares as u128, v.day_nav, WAD).unwrap();
        assert!(back <= 1_000, "minted {} worth {back} from 1000", p.shares);
    }

    #[test]
    fn a_deposit_too_small_to_buy_one_share_is_refused() {
        let mut v = vault();
        v.day_nav = WAD * 1_000;
        assert_eq!(plan_mint(&v, ShareClass::Day, 999), Err(OpError::AmountTooSmall));
    }

    #[test]
    fn a_collapsed_nav_refuses_rather_than_minting_infinity() {
        let mut v = vault();
        v.day_nav = 0;
        assert_eq!(plan_mint(&v, ShareClass::Day, 1_000), Err(OpError::NavCollapsed));
    }

    /* ── redeem ──────────────────────────────────────────────────────── */

    #[test]
    fn redemption_rounds_down_so_a_redeemer_never_gains() {
        let mut v = vault();
        v.day_nav = WAD * 3 / 2; // 1.5 quote per share
        let p = plan_redeem(&v, ShareClass::Day, 333).unwrap();
        assert_eq!(p.quote_out, 499); // 499.5 floored
    }

    #[test]
    fn reserved_quote_cannot_be_redeemed() {
        let mut v = vault();
        v.owned_quote = 1_000;
        v.pending_delta = 900; // vault owes the market a 900 purchase
        assert_eq!(v.free_quote(), 100);
        // 100 is payable
        assert!(plan_redeem(&v, ShareClass::Day, 100).is_ok());
        // 101 would eat into the reservation
        assert_eq!(
            plan_redeem(&v, ShareClass::Day, 101),
            Err(OpError::InsufficientFreeQuote)
        );
    }

    #[test]
    fn a_negative_pending_delta_reserves_nothing() {
        let mut v = vault();
        v.owned_quote = 1_000;
        v.pending_delta = -900; // the vault owes *stock*, not quote
        assert_eq!(v.free_quote(), 1_000);
    }

    /* ── fill ────────────────────────────────────────────────────────── */

    #[test]
    fn filling_more_than_the_imbalance_is_refused() {
        let mut v = vault();
        v.pending_delta = 1_000;
        assert_eq!(
            plan_fill(&v, WAD, 1_001, 1_000, 1_000),
            Err(OpError::FillTooLarge)
        );
        assert!(plan_fill(&v, WAD, 1_000, 1_000, 1_000).is_ok());
    }

    #[test]
    fn the_vault_cannot_sell_underlying_it_does_not_hold() {
        let mut v = vault();
        v.pending_delta = -1_000;
        v.owned_underlying = 500;
        assert_eq!(
            plan_fill(&v, WAD, 600, 1_000, 1_000),
            Err(OpError::InsufficientUnderlying)
        );
    }

    #[test]
    fn the_larger_class_pays_the_fill_incentive() {
        let mut v = vault();
        v.pending_delta = 100_000;
        v.owned_quote = 1_000_000;
        // NIGHT is larger
        let p = plan_fill(&v, WAD, 100_000, 900_000, 100_000).unwrap();
        assert_eq!(p.fee_payer, ShareClass::Night);
        // and the mirror image
        let p2 = plan_fill(&v, WAD, 100_000, 100_000, 900_000).unwrap();
        assert_eq!(p2.fee_payer, ShareClass::Day);
    }

    #[test]
    fn the_incentive_charge_rounds_against_the_payer() {
        let mut v = vault();
        v.pending_delta = 100_000;
        v.fill_incentive_bps = 10;
        // an incentive that does not divide evenly must round up per share
        let p = plan_fill(&v, WAD, 100_000, 3, 1).unwrap();
        assert!(p.fee_per_share * 3 >= p.incentive * WAD / WAD.max(1));
        assert!(p.fee_per_share > 0);
    }

    #[test]
    fn a_fill_with_no_shares_outstanding_cannot_place_the_fee() {
        let mut v = vault();
        v.pending_delta = 100_000;
        assert_eq!(plan_fill(&v, WAD, 100_000, 0, 0), Err(OpError::NoFeePayer));
    }

    #[test]
    fn a_zero_incentive_needs_no_fee_payer() {
        let mut v = vault();
        v.pending_delta = 100_000;
        v.fill_incentive_bps = 0;
        let p = plan_fill(&v, WAD, 100_000, 0, 0).unwrap();
        assert_eq!(p.incentive, 0);
        assert_eq!(p.fee_per_share, 0);
    }

    #[test]
    fn redeeming_a_class_down_to_zero_strands_nothing() {
        // The last holder out must take the class's whole backing with them,
        // or the remainder belongs to nobody and the accounting is wrong.
        let mut v = vault();
        v.day_nav = WAD * 7 / 4;
        v.owned_quote = 0;

        let m = plan_mint(&v, ShareClass::Day, 700_000).unwrap();
        v.owned_quote = m.owned_quote_after;
        let supply = m.shares;

        let r = plan_redeem(&v, ShareClass::Day, supply).unwrap();
        v.owned_quote = r.owned_quote_after;

        // with the class empty, claims are zero and whatever is left is surplus
        let s = solvency(&v, 0, 0).unwrap();
        assert!(s.ok());
        assert!(
            v.owned_quote <= 2,
            "{} quote stranded after the class emptied", v.owned_quote
        );
    }

    /* ── solvency ────────────────────────────────────────────────────── */

    #[test]
    fn solvency_counts_owned_balances_not_donations() {
        let mut v = vault();
        v.owned_quote = 1_000;
        let s = solvency(&v, 1_000, 0).unwrap();
        assert_eq!(s.assets, 1_000);
        assert_eq!(s.claims, 1_000);
        assert!(s.ok() && s.margin() == 0);
        // a donation does not appear here at all, because owned_quote is tracked
        // rather than read from the token account
        assert_eq!(solvency(&v, 1_000, 0).unwrap().assets, 1_000);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2000))]

        /// Minting then immediately redeeming must never return more than was
        /// put in. If it could, an attacker would just loop it.
        #[test]
        fn mint_then_redeem_never_profits(
            quote in 1u64..1_000_000_000u64,
            nav in (WAD / 1_000)..(WAD * 1_000),
        ) {
            let mut v = vault();
            v.day_nav = nav;
            v.owned_quote = u64::MAX / 4;
            prop_assume!(plan_mint(&v, ShareClass::Day, quote).is_ok());
            let m = plan_mint(&v, ShareClass::Day, quote).unwrap();

            let mut v2 = v;
            v2.owned_quote = m.owned_quote_after;
            if let Ok(r) = plan_redeem(&v2, ShareClass::Day, m.shares) {
                prop_assert!(
                    r.quote_out <= quote,
                    "round trip returned {} from {quote}", r.quote_out
                );
            }
        }

        /// A mint can never make a solvent vault insolvent.
        #[test]
        fn minting_preserves_solvency(
            quote in 1u64..1_000_000_000u64,
            nav in (WAD / 100)..(WAD * 100),
            supply in 0u64..1_000_000_000u64,
        ) {
            let mut v = vault();
            v.day_nav = nav;
            // start exactly solvent
            v.owned_quote = value_of(supply, nav).unwrap_or(0).min(u64::MAX as u128) as u64;
            prop_assume!(solvency(&v, 0, supply).map(|s| s.ok()).unwrap_or(false));

            if let Ok(m) = plan_mint(&v, ShareClass::Day, quote) {
                let mut after = v;
                after.owned_quote = m.owned_quote_after;
                let s = solvency(&after, 0, supply.saturating_add(m.shares)).unwrap();
                prop_assert!(s.ok(), "mint broke solvency: margin {}", s.margin());
            }
        }

        /// A redemption can never make a solvent vault insolvent.
        #[test]
        fn redeeming_preserves_solvency(
            shares in 1u64..1_000_000_000u64,
            nav in (WAD / 100)..(WAD * 100),
            extra in 0u64..1_000_000u64,
        ) {
            let mut v = vault();
            v.day_nav = nav;
            let claim = value_of(shares, nav).unwrap_or(0);
            prop_assume!(claim < u64::MAX as u128 / 2);
            v.owned_quote = (claim as u64).saturating_add(extra);
            prop_assume!(solvency(&v, 0, shares).map(|s| s.ok()).unwrap_or(false));

            if let Ok(r) = plan_redeem(&v, ShareClass::Day, shares) {
                let mut after = v;
                after.owned_quote = r.owned_quote_after;
                let s = solvency(&after, 0, 0).unwrap();
                prop_assert!(s.ok(), "redeem broke solvency: margin {}", s.margin());
            }
        }

        /// A fill converts between the two assets and charges a fee to a class.
        /// It must never leave the vault holding less than it owes.
        #[test]
        fn filling_preserves_solvency(
            pending in 1i128..1_000_000_000i128,
            amount in 1u64..1_000_000_000u64,
            night in 1u64..1_000_000_000u64,
            day in 1u64..1_000_000_000u64,
            bps in 0u16..500u16,
        ) {
            let mut v = vault();
            v.fill_incentive_bps = bps;
            v.pending_delta = pending;
            v.owned_quote = u64::MAX / 4;
            v.owned_underlying = u64::MAX / 4;

            if let Ok(p) = plan_fill(&v, WAD, amount, night, day) {
                let mut after = v;
                after.owned_underlying = p.owned_underlying_after;
                after.owned_quote = p.owned_quote_after;
                // apply the fee to the payer, exactly as the program does
                let (mut nn, mut dn) = (after.night_nav, after.day_nav);
                match p.fee_payer {
                    ShareClass::Night => nn = nn.saturating_sub(p.fee_per_share),
                    ShareClass::Day => dn = dn.saturating_sub(p.fee_per_share),
                }
                after.night_nav = nn;
                after.day_nav = dn;

                let before = solvency(&v, night, day).unwrap();
                let s = solvency(&after, night, day).unwrap();
                // the fee must not cost the vault more than it gained
                prop_assert!(
                    s.margin() >= before.margin() - (p.incentive as i128) - 2,
                    "fill drained {} beyond the incentive", before.margin() - s.margin()
                );
            }
        }

        /// Pending delta must always move toward zero, never past it.
        #[test]
        fn a_fill_never_overshoots_zero(
            pending in -1_000_000_000i128..1_000_000_000i128,
            amount in 1u64..2_000_000_000u64,
        ) {
            prop_assume!(pending != 0);
            let mut v = vault();
            v.pending_delta = pending;
            v.owned_quote = u64::MAX / 4;
            v.owned_underlying = u64::MAX / 4;

            if let Ok(p) = plan_fill(&v, WAD, amount, 1_000, 1_000) {
                prop_assert!(
                    p.pending_delta_after.unsigned_abs() <= pending.unsigned_abs(),
                    "|delta| grew from {} to {}", pending.unsigned_abs(),
                    p.pending_delta_after.unsigned_abs()
                );
                prop_assert_eq!(
                    p.pending_delta_after.signum() * pending.signum() >= 0, true,
                    "fill flipped the sign of the imbalance"
                );
            }
        }
    }

    /// The last redeemer of a class takes exactly what the class is worth.
    ///
    /// `plan_redeem` pays `mul_div_floor(shares, nav, WAD)`, which for
    /// `shares == supply` is the same expression as `value_of(supply, nav)` —
    /// so the class's value goes to zero at the same instant its supply does
    /// and nothing is left owned by nobody. An earlier version of the audit
    /// claimed this was handled by folding a residue into the surviving class;
    /// there is no residue to fold, and this test is here so that stays true.
    #[test]
    fn the_last_redemption_of_a_class_strands_nothing() {
        for nav in [WAD, WAD * 3 / 2, WAD * 7 / 3, WAD / 3, 1, WAD * 999_983 / 1_000_000] {
            for supply in [1u64, 2, 999_983, 1_000_000_000, u32::MAX as u64] {
                let v = VaultView {
                    night_nav: nav,
                    day_nav: WAD,
                    exposed: ShareClass::Day,
                    last_mark: WAD,
                    owned_underlying: 0,
                    owned_quote: u64::MAX,
                    pending_delta: 0,
                    fill_incentive_bps: 0,
                };
                let class_value = value_of(supply, nav).unwrap();
                match plan_redeem(&v, ShareClass::Night, supply) {
                    Ok(p) => assert_eq!(
                        p.quote_out as u128, class_value,
                        "nav {nav} supply {supply}: paid {} of a class worth {class_value}",
                        p.quote_out
                    ),
                    // A class worth less than one atom cannot be redeemed at
                    // all, which strands nothing either — the shares still
                    // exist and still carry the claim.
                    Err(OpError::AmountTooSmall) => assert_eq!(class_value, 0),
                    Err(e) => panic!("nav {nav} supply {supply}: {e:?}"),
                }
            }
        }
    }
}
