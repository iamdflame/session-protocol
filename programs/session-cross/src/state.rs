//! Accounts.
//!
//! - **`CrossConfig`**, one per deployment: the admin and the treasury that
//!   collects each cross's rounding dust.
//! - **`Market`**, one per xStock: its session-bell listing, the two mints,
//!   the escrow accounts both mints are held in, and the parameters.
//! - **`Cross`**, one per market, trading day and bell: the book's totals,
//!   the price once the print is final, the makers' ladder, the clearing, and
//!   a tracked account of every atom in and out.
//! - **`Order`** and **`Offer`**: one person's side of a cross.
//!
//! Escrow is shared by every cross of a market and never read: each cross
//! tracks what it put in and took out, and no settlement may take out more
//! than its cross put in. Tokens anyone transfers in uninvited belong to
//! nobody's cross.

use anchor_lang::prelude::*;
use session_core::cross::LADDER;

pub const CROSS_VERSION: u8 = 1;

#[account]
#[derive(InitSpace)]
pub struct CrossConfig {
    pub version: u8,
    pub bump: u8,
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    /// Owner of the token accounts a closed cross's dust is swept to.
    pub treasury: Pubkey,
}

impl CrossConfig {
    pub const SEED: &'static [u8] = b"cross-config";
    pub const SIZE: usize = 8 + Self::INIT_SPACE + 32;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct MarketParams {
    /// Orders are placed and cancelled until this long before the bell.
    pub freeze_secs: u32,
    /// How long makers have to post, once the imbalance is known.
    pub auction_secs: u32,
    /// No final print this long after the bell, and the cross is cancelled.
    pub cancel_after_secs: u32,
    /// The highest fee a maker may ask.
    pub max_fee_bps: u16,
    pub min_order_quote: u64,
    pub min_order_raw: u64,
    /// Caps on each side of one cross.
    pub max_side_quote: u64,
    pub max_side_raw: u64,
    /// How far Pyth's redemption rate may sit from the mint's multiplier.
    pub rr_tolerance_bps: u16,
    /// A multiplier activation this close to the bell cancels the cross.
    pub multiplier_guard_secs: u32,
    /// Whether prints verified through a test signer may price this market.
    /// Devnet only; a market holding real value sets false.
    pub accept_simulated: bool,
}

impl MarketParams {
    pub fn valid(&self) -> bool {
        (30..=3_600).contains(&self.freeze_secs)
            && (15..=1_800).contains(&self.auction_secs)
            && (3_600..=172_800).contains(&self.cancel_after_secs)
            && (self.max_fee_bps as usize) < LADDER
            && self.min_order_quote > 0
            && self.min_order_raw > 0
            && self.max_side_quote >= self.min_order_quote
            && self.max_side_raw >= self.min_order_raw
            && (1..=100).contains(&self.rr_tolerance_bps)
            && (60..=86_400).contains(&self.multiplier_guard_secs)
    }
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub version: u8,
    pub bump: u8,
    /// New orders allowed. Clearing, settlement and refunds never stop.
    pub active: bool,
    /// The session-bell listing whose prints price this market.
    pub listing: Pubkey,
    /// The xStock, in raw atoms.
    pub mint: Pubkey,
    pub mint_decimals: u8,
    pub mint_program: Pubkey,
    /// The quote token, USDC on mainnet.
    pub quote_mint: Pubkey,
    pub quote_decimals: u8,
    pub quote_program: Pubkey,
    pub raw_escrow: Pubkey,
    pub quote_escrow: Pubkey,
    pub params: MarketParams,
    pub crosses: u64,
    pub orders: u64,
}

impl Market {
    pub const SEED: &'static [u8] = b"market";
    pub const RAW_ESCROW_SEED: &'static [u8] = b"raw-escrow";
    pub const QUOTE_ESCROW_SEED: &'static [u8] = b"quote-escrow";
    pub const SIZE: usize = 8 + Self::INIT_SPACE + 32;
}

pub const PHASE_COLLECTING: u8 = 0;
pub const PHASE_CONFIRMING: u8 = 1;
pub const PHASE_AUCTION: u8 = 2;
pub const PHASE_SETTLING: u8 = 3;
pub const PHASE_CANCELLED: u8 = 4;

pub const CROWDED_NONE: u8 = 0;
pub const CROWDED_BUYERS: u8 = 1;
pub const CROWDED_SELLERS: u8 = 2;

#[account]
#[derive(InitSpace)]
pub struct Cross {
    pub version: u8,
    pub bump: u8,
    pub phase: u8,
    /// 0 open, 1 close: session-bell's kinds.
    pub kind: u8,
    pub crowded: u8,
    pub simulated: bool,
    pub market: Pubkey,
    pub day: i64,
    pub bell_ts: i64,
    /// Paid the rent; gets it back when the cross closes.
    pub created_by: Pubkey,

    // ── the price ──────────────────────────────────────────────────────
    pub print: Pubkey,
    pub price_mantissa: i64,
    pub price_expo: i16,
    /// The share price in 10⁻⁸ USD, which limits are written in.
    pub price_e8: u64,
    pub multiplier_wad: u128,
    /// `X`: quote atoms per raw atom, WAD.
    pub price_wad: u128,

    // ── the book ───────────────────────────────────────────────────────
    pub n_orders: u32,
    pub n_confirmed: u32,
    pub n_settled: u32,
    pub buy_total: u64,
    pub sell_total: u64,
    /// In band, once confirmed.
    pub buy_in: u64,
    pub sell_in: u64,

    // ── the auction ────────────────────────────────────────────────────
    pub auction_end: i64,
    pub n_offers: u32,
    pub n_offers_settled: u32,
    /// Makers' capacity by fee, one bucket per basis point: raw atoms when
    /// buyers are crowded, quote atoms when sellers are.
    pub ladder: [u64; LADDER],

    // ── the clearing (session_core::cross::Clearing) ───────────────────
    pub fee_bps: u16,
    pub maker_price_wad: u128,
    pub marginal_fee_bps: u16,
    pub marginal_need: u128,
    pub marginal_cap: u128,
    pub buy_spent: u128,
    pub buy_tokens: u128,
    pub sell_spent: u128,
    pub sell_quote: u128,

    // ── this cross's escrow, tracked ───────────────────────────────────
    pub quote_in: u64,
    pub quote_out: u64,
    pub raw_in: u64,
    pub raw_out: u64,

    pub priced_at: i64,
    pub cleared_at: i64,
}

impl Cross {
    pub const SEED: &'static [u8] = b"cross";
    pub const SIZE: usize = 8 + Self::INIT_SPACE + 32;

    /// The clearing this cross stored, as the pure type the legs take.
    pub fn clearing(&self) -> session_core::cross::Clearing {
        use session_core::cross::{Clearing, Crowded};
        Clearing {
            crowded: match self.crowded {
                CROWDED_BUYERS => Crowded::Buyers,
                CROWDED_SELLERS => Crowded::Sellers,
                _ => Crowded::Balanced,
            },
            price_wad: self.price_wad,
            fee_bps: self.fee_bps,
            maker_price_wad: self.maker_price_wad,
            marginal_fee_bps: self.marginal_fee_bps,
            marginal_need: self.marginal_need,
            marginal_cap: self.marginal_cap,
            buy_in: self.buy_in as u128,
            buy_spent: self.buy_spent,
            buy_tokens: self.buy_tokens,
            sell_in: self.sell_in as u128,
            sell_spent: self.sell_spent,
            sell_quote: self.sell_quote,
        }
    }

    pub fn store(&mut self, c: &session_core::cross::Clearing) {
        use session_core::cross::Crowded;
        self.crowded = match c.crowded {
            Crowded::Buyers => CROWDED_BUYERS,
            Crowded::Sellers => CROWDED_SELLERS,
            Crowded::Balanced => CROWDED_NONE,
        };
        self.fee_bps = c.fee_bps;
        self.maker_price_wad = c.maker_price_wad;
        self.marginal_fee_bps = c.marginal_fee_bps;
        self.marginal_need = c.marginal_need;
        self.marginal_cap = c.marginal_cap;
        self.buy_spent = c.buy_spent;
        self.buy_tokens = c.buy_tokens;
        self.sell_spent = c.sell_spent;
        self.sell_quote = c.sell_quote;
    }
}

pub const SIDE_BUY: u8 = 0;
pub const SIDE_SELL: u8 = 1;

pub const ORDER_OPEN: u8 = 0;
pub const ORDER_IN_BAND: u8 = 1;
pub const ORDER_OUT_OF_BAND: u8 = 2;

/// Settled legs, as bits.
pub const LEG_QUOTE: u8 = 1;
pub const LEG_RAW: u8 = 2;
pub const LEGS_ALL: u8 = LEG_QUOTE | LEG_RAW;

#[account]
#[derive(InitSpace)]
pub struct Order {
    pub version: u8,
    pub bump: u8,
    pub side: u8,
    pub status: u8,
    pub legs: u8,
    pub cross: Pubkey,
    pub owner: Pubkey,
    pub nonce: u16,
    /// Quote atoms for a buy, raw atoms for a sell.
    pub amount: u64,
    /// The worst share price the owner accepts, in 10⁻⁸ USD: a maximum for
    /// a buy, a minimum for a sell. Zero: any price.
    pub limit_e8: u64,
    pub placed_at: i64,
}

impl Order {
    pub const SEED: &'static [u8] = b"order";
    pub const SIZE: usize = 8 + Self::INIT_SPACE;
}

#[account]
#[derive(InitSpace)]
pub struct Offer {
    pub version: u8,
    pub bump: u8,
    /// `CROWDED_BUYERS`: the maker escrowed raw tokens to sell. `CROWDED_SELLERS`:
    /// quote, to buy.
    pub side: u8,
    pub legs: u8,
    pub fee_bps: u16,
    pub cross: Pubkey,
    pub maker: Pubkey,
    pub nonce: u16,
    pub size: u64,
    pub posted_at: i64,
}

impl Offer {
    pub const SEED: &'static [u8] = b"offer";
    pub const SIZE: usize = 8 + Self::INIT_SPACE;
}

/// Whether an order takes part at this price: a buy at or under its limit, a
/// sell at or over it.
pub fn in_band(side: u8, limit_e8: u64, price_e8: u64) -> bool {
    limit_e8 == 0
        || match side {
            SIDE_BUY => price_e8 <= limit_e8,
            _ => price_e8 >= limit_e8,
        }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits() {
        assert!(in_band(SIDE_BUY, 0, 22_406_000_000));
        assert!(in_band(SIDE_BUY, 22_406_000_000, 22_406_000_000), "a buy limit is inclusive");
        assert!(!in_band(SIDE_BUY, 22_405_999_999, 22_406_000_000));
        assert!(in_band(SIDE_SELL, 22_406_000_000, 22_406_000_000), "so is a sell limit");
        assert!(!in_band(SIDE_SELL, 22_406_000_001, 22_406_000_000));
    }

    #[test]
    fn sizes() {
        assert!(Cross::SIZE < 10_240, "a cross must fit one account allocation");
        println!("config {} market {} cross {} order {} offer {}", CrossConfig::SIZE, Market::SIZE, Cross::SIZE, Order::SIZE, Offer::SIZE);
    }
}
