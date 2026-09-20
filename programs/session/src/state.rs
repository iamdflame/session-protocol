//! On-chain account state.

use anchor_lang::prelude::*;

use crate::calendar::Session;
use crate::funding::FundingParams;
use crate::oracle::Guards;
use crate::settle::{NavState, ShareClass};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Class {
    Night,
    Day,
}

impl From<Class> for ShareClass {
    fn from(c: Class) -> Self {
        match c {
            Class::Night => ShareClass::Night,
            Class::Day => ShareClass::Day,
        }
    }
}

impl From<ShareClass> for Class {
    fn from(c: ShareClass) -> Self {
        match c {
            ShareClass::Night => Class::Night,
            ShareClass::Day => Class::Day,
        }
    }
}

/// Which class should hold the stock during a given session.
///
/// This is the whole protocol in one line: when the real market is shut, the
/// NIGHT class owns the exposure; when it is open, the DAY class does.
pub const fn class_for(session: Session) -> ShareClass {
    match session {
        Session::Closed => ShareClass::Night,
        Session::Open => ShareClass::Day,
    }
}

#[account]
#[derive(Debug)]
pub struct Vault {
    pub bump: u8,
    pub authority: Pubkey,

    // assets
    pub underlying_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub underlying_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub underlying_decimals: u8,
    pub quote_decimals: u8,

    // the two claims
    pub night_mint: Pubkey,
    pub day_mint: Pubkey,

    // Pyth feed ids. `mark` prices the token 24/7; `equity` only publishes while
    // the real market is open, which is how the vault second-guesses its calendar.
    pub mark_feed_id: [u8; 32],
    pub equity_feed_id: [u8; 32],

    // accounting — quote atoms per share atom, WAD-scaled
    pub night_nav: u128,
    pub day_nav: u128,
    pub last_mark: u128,
    /// Which class currently holds the underlying.
    pub exposed: Class,
    pub last_boundary_ts: i64,
    pub boundary_count: u64,

    /// Quote-atom value of underlying still to be bought (+) or sold (−) before
    /// inventory matches the newly exposed class. Zero whenever the two sides
    /// are the same size, which is the design target.
    pub pending_delta: i128,

    // params
    pub funding_k_bps: u32,
    pub funding_max_bps: u32,
    pub max_stale_secs: u32,
    pub max_conf_bps: u16,
    pub max_move_bps: u16,
    pub equity_quiet_secs: u32,
    /// Incentive paid to whoever fills the imbalance, in basis points.
    pub fill_incentive_bps: u16,

    // analytics
    pub cum_funding_night: i128,

    pub paused: bool,
}

impl Vault {
    pub const SEED: &'static [u8] = b"vault";
    /// 8 discriminator + fields, rounded up generously for future additions.
    pub const SIZE: usize = 8 + 512;

    pub fn funding_params(&self) -> FundingParams {
        FundingParams { k_bps: self.funding_k_bps, max_bps: self.funding_max_bps }
    }

    pub fn guards(&self) -> Guards {
        Guards {
            max_stale_secs: self.max_stale_secs,
            max_conf_bps: self.max_conf_bps,
            max_move_bps: self.max_move_bps,
            equity_quiet_secs: self.equity_quiet_secs,
        }
    }

    pub fn nav_state(&self, night_supply: u64, day_supply: u64) -> NavState {
        NavState {
            night_supply,
            day_supply,
            night_nav: self.night_nav,
            day_nav: self.day_nav,
            exposed: self.exposed.into(),
            last_mark: self.last_mark,
        }
    }

    pub fn nav_of(&self, class: Class) -> u128 {
        match class {
            Class::Night => self.night_nav,
            Class::Day => self.day_nav,
        }
    }

    /// A class may only be minted or redeemed while it is parked in quote.
    ///
    /// This is the constraint that keeps primary issuance free of market impact:
    /// a parked class holds only quote, so creating or destroying its shares
    /// moves quote in or out and never requires buying or selling stock. It is
    /// the same discipline an ETF uses — authorised participants create at NAV,
    /// everyone else trades the secondary market.
    pub fn is_parked(&self, class: Class) -> bool {
        self.exposed != class
    }
}

#[event]
pub struct BoundarySettled {
    pub vault: Pubkey,
    pub ts: i64,
    pub boundary: u64,
    /// The class that now holds the stock.
    pub exposed: Class,
    pub mark: u128,
    pub night_nav: u128,
    pub day_nav: u128,
    /// Positive means NIGHT paid DAY.
    pub funding: i128,
    pub pending_delta: i128,
}

#[event]
pub struct SharesMinted {
    pub vault: Pubkey,
    pub class: Class,
    pub quote_in: u64,
    pub shares_out: u64,
    pub nav: u128,
}

#[event]
pub struct SharesRedeemed {
    pub vault: Pubkey,
    pub class: Class,
    pub shares_in: u64,
    pub quote_out: u64,
    pub nav: u128,
}

#[event]
pub struct HandoffFilled {
    pub vault: Pubkey,
    pub filler: Pubkey,
    /// Positive: the filler sold underlying to the vault.
    pub underlying_delta: i64,
    pub quote_delta: i64,
    pub remaining_delta: i128,
}
