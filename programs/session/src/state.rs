//! On-chain account state.
//!
//! Two decisions here are load-bearing.
//!
//! **Balances are tracked, not read.** `owned_underlying` / `owned_quote` are
//! what the vault believes it holds. Anyone can transfer tokens into a vault's
//! token accounts, and a vault that derived its position from
//! `token_account.amount` would silently absorb those transfers into its
//! accounting — making every solvency check ambiguous and handing an attacker a
//! way to perturb settlement. The difference between the balance and the owned
//! figure is surplus, and surplus is skimmable, never spendable.
//!
//! **The session is tracked, not inferred.** See `machine.rs`: inferring it from
//! `session_at(now)` cannot distinguish zero boundaries from two.

use anchor_lang::prelude::*;

use crate::calendar::Session;
use crate::funding::FundingParams;
use crate::oracle::Guards;
use crate::ops::VaultView;
use crate::settle::{NavState, ShareClass};

/// Bumped when the account layout changes. An account written by a different
/// version is rejected rather than reinterpreted.
pub const VAULT_VERSION: u8 = 2;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
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

/// Why a vault stopped. Stored so an operator sees the cause without replaying
/// logs, and so recovery can require an explicit acknowledgement of it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum HaltReason {
    None,
    /// Two or more boundaries elapsed without a crank. The intermediate mark is
    /// unrecoverable, so any settlement now would pay a session to the wrong class.
    MissedBoundary,
    /// A previous handoff was never filled and another boundary arrived.
    UnfilledHandoff,
    /// Assets no longer cover claims.
    Insolvent,
    /// A price move produced a loss larger than the exposed class was worth.
    /// Only reachable when an unfilled handoff left the vault badly over-hedged.
    BadDebt,
    /// Stored state contradicts the calendar.
    Inconsistent,
    /// Stopped by the authority.
    Operator,
    /// The issuer of the underlying used a power the vault cannot override:
    /// set a transfer hook, paused the mint, froze the vault's token account,
    /// or moved inventory out under a permanent delegate. The halt detail
    /// says which (`issuer::Condition`). Appended, never inserted.
    IssuerAction,
}

/// What a "session" is for this vault. The program is one; the clock differs.
///
/// `EQUITY`: NYSE hours, Pyth's US-equity feed going quiet is the bell.
/// `EVENT`: a private or pre-IPO name with no exchange session. The boundary
/// is the next discrete print (a tender, a round, a 409A) from an on-chain
/// schedule, or the moment the token's price diverges from its mark by more
/// than the vault tolerates. The share classes are then NOW and THEN rather
/// than DAY and NIGHT, on the same two mints.
pub const SESSION_EQUITY: u8 = 0;
pub const SESSION_EVENT: u8 = 1;

/// Granular pause bits. Settlement is deliberately *not* pausable: freezing NAV
/// while the price keeps moving means the first boundary after resuming hands
/// one class the entire suppressed move. Pausing must stop trading without
/// corrupting accounting.
pub const PAUSE_MINT: u8 = 1 << 0;
pub const PAUSE_REDEEM: u8 = 1 << 1;
pub const PAUSE_FILL: u8 = 1 << 2;
pub const PAUSE_ALL: u8 = PAUSE_MINT | PAUSE_REDEEM | PAUSE_FILL;

#[account]
#[derive(Debug, InitSpace)]
pub struct Vault {
    pub version: u8,
    pub bump: u8,
    pub authority: Pubkey,
    /// Two-step handover: a proposed authority must accept before it takes
    /// effect, so a typo cannot strand a vault with an unreachable key.
    pub pending_authority: Pubkey,

    // ── assets ───────────────────────────────────────────────────────────
    pub underlying_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub underlying_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub underlying_decimals: u8,
    pub quote_decimals: u8,

    /// What the vault owns, as opposed to what happens to sit in its token
    /// accounts. Never read from `token_account.amount`.
    pub owned_underlying: u64,
    pub owned_quote: u64,

    // ── the two claims ───────────────────────────────────────────────────
    pub night_mint: Pubkey,
    pub day_mint: Pubkey,

    // ── oracle ───────────────────────────────────────────────────────────
    /// Prices the token 24/7. This is what the vault's assets are worth.
    pub mark_feed_id: [u8; 32],
    /// Publishes only while the real market is open, so its staleness is the
    /// closing bell. Cross-checks the calendar.
    pub equity_feed_id: [u8; 32],

    // ── accounting ───────────────────────────────────────────────────────
    /// Quote atoms per share atom, WAD-scaled.
    pub night_nav: u128,
    pub day_nav: u128,
    /// Quote atoms per underlying atom at the last boundary, WAD-scaled.
    pub last_mark: u128,
    /// Which class holds the underlying right now.
    pub exposed: Class,
    /// The session in force at the last settlement. Tracked, never inferred.
    pub last_session_open: bool,
    pub last_boundary_ts: i64,
    pub boundary_count: u64,

    /// Quote-atom value of underlying still to be bought (+) or sold (−) so
    /// inventory matches the exposed class. Zero whenever the two sides are the
    /// same size, which is the design target.
    pub pending_delta: i128,

    // ── parameters ───────────────────────────────────────────────────────
    pub funding_k_bps: u32,
    pub funding_max_bps: u32,
    pub max_stale_secs: u32,
    pub max_conf_bps: u16,
    pub max_move_bps: u16,
    pub equity_quiet_secs: u32,
    pub fill_incentive_bps: u16,
    /// How large an unfilled handoff may be, relative to total value, before
    /// the next boundary refuses to settle. In basis points.
    pub max_carry_delta_bps: u16,
    /// How long the vault may believe the market is shut during a nominal
    /// session before halting. Guards against a silent equity-feed outage
    /// letting NIGHT earn through what should be DAY sessions.
    pub max_unexpected_closed_secs: u32,

    // ── lifecycle ────────────────────────────────────────────────────────
    pub flags: u8,
    pub halted: bool,
    pub halt_reason: HaltReason,

    // ── analytics ────────────────────────────────────────────────────────
    pub cum_funding_night: i128,
    pub cum_fill_incentive: u64,
    pub total_minted_night: u64,
    pub total_minted_day: u64,

    // ── layout v2 ────────────────────────────────────────────────────────
    /// `SESSION_EQUITY` or `SESSION_EVENT`.
    pub session_kind: u8,
    /// The listed name, NUL-padded: `NVDA`, `OPENAI`. Names the share classes.
    pub symbol: [u8; 8],
    /// A mark's `posted_slot` may be at most this many slots behind the clock.
    /// Bounds how long a price-update account may sit around before being read
    /// as current, on top of the publish-time window.
    pub max_posted_slot_age: u32,
    /// At a settlement the mark may be published up to this long *before* the
    /// bell: the last print before the close is the close.
    pub max_bell_lead_secs: u32,
    /// Event sessions only: token price vs mark divergence, in basis points,
    /// beyond which THEN is deemed exposed.
    pub max_premium_bps: u16,
    /// How long after a settlement the residual is offered at one price to
    /// everyone before ordinary fills resume.
    pub auction_secs: u32,
    /// Fill incentive by elapsed time since the bell: within the auction
    /// window, within twice it, after. In basis points.
    pub incentive_ramp: [u16; 3],
    /// Whether a recap must carry a Pyth update for every boundary it replays.
    /// A devnet instance without a posting keeper cannot produce those, and
    /// says so on its instrument card rather than pretending.
    pub require_verified_recap: bool,
    /// Fills are refused until this instant. Set by a jump at a settlement.
    pub fill_paused_until: i64,
    pub last_recap_ts: i64,
    pub recap_count: u32,
    /// Event sessions only: the key allowed to post the detector reading.
    pub detector_authority: Pubkey,
    /// The program that owns the share mints. Recorded so a client never has
    /// to guess which ATA derivation applies.
    pub share_token_program: Pubkey,
}

impl Vault {
    pub const SEED: &'static [u8] = b"vault";
    /// Derived, never hand-counted. A little slack is left for fields added
    /// under the same layout version.
    pub const SIZE: usize = 8 + Self::INIT_SPACE + 64;

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

    pub fn is_event(&self) -> bool {
        self.session_kind == SESSION_EVENT
    }

    pub fn symbol_str(&self) -> &str {
        let end = self.symbol.iter().position(|&b| b == 0).unwrap_or(self.symbol.len());
        core::str::from_utf8(&self.symbol[..end]).unwrap_or("")
    }

    pub fn last_session(&self) -> Session {
        if self.last_session_open { Session::Open } else { Session::Closed }
    }

    pub fn set_last_session(&mut self, s: Session) {
        self.last_session_open = matches!(s, Session::Open);
    }

    /// The slice of state the policy layer operates on. Every instruction goes
    /// through this, so the rules that are property-tested in `ops` are the
    /// rules the program actually runs — not a parallel implementation of them.
    pub fn view(&self) -> VaultView {
        VaultView {
            night_nav: self.night_nav,
            day_nav: self.day_nav,
            exposed: self.exposed.into(),
            last_mark: self.last_mark,
            owned_underlying: self.owned_underlying,
            owned_quote: self.owned_quote,
            pending_delta: self.pending_delta,
            fill_incentive_bps: self.fill_incentive_bps,
        }
    }

    pub fn nav_state(&self, night_supply: u64, day_supply: u64) -> NavState {
        NavState {
            night_supply,
            day_supply,
            owned_underlying: self.owned_underlying,
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

    pub fn mint_of(&self, class: Class) -> Pubkey {
        match class {
            Class::Night => self.night_mint,
            Class::Day => self.day_mint,
        }
    }

    /// A class may only be minted or redeemed while it is parked in quote.
    ///
    /// A parked class holds only quote, so creating or destroying its shares
    /// moves quote in or out and never requires buying or selling stock —
    /// primary issuance has no market impact by construction. Same discipline
    /// an ETF uses: authorised participants create at NAV, everyone else trades
    /// the secondary market.
    pub fn is_parked(&self, class: Class) -> bool {
        self.exposed != class
    }

    pub fn paused(&self, bit: u8) -> bool {
        self.flags & bit != 0
    }

    /// Quote the vault has committed to a pending purchase and may not pay out.
    ///
    /// Without this a redeemer could take the quote earmarked for an outstanding
    /// handoff, leaving it unfillable and the vault's inventory wrong.
    pub fn reserved_quote(&self) -> u64 {
        if self.pending_delta > 0 {
            (self.pending_delta as u128).min(u64::MAX as u128) as u64
        } else {
            0
        }
    }

    /// Quote that may actually be paid out.
    pub fn free_quote(&self) -> u64 {
        self.owned_quote.saturating_sub(self.reserved_quote())
    }
}

/* ── events ──────────────────────────────────────────────────────────────────
   Events carry enough to reconstruct vault state off chain without replaying
   every transaction: supplies and owned balances travel with every mutation.
*/

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub underlying_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub night_mint: Pubkey,
    pub day_mint: Pubkey,
    pub mark: u128,
    pub exposed: Class,
    pub ts: i64,
}

#[event]
pub struct BoundarySettled {
    pub vault: Pubkey,
    pub ts: i64,
    pub boundary: u64,
    pub exposed: Class,
    pub mark: u128,
    pub night_nav: u128,
    pub day_nav: u128,
    pub night_supply: u64,
    pub day_supply: u64,
    /// Positive means NIGHT paid DAY.
    pub funding: i128,
    pub pending_delta: i128,
    pub owned_underlying: u64,
    pub owned_quote: u64,
}

#[event]
pub struct SharesMinted {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub class: Class,
    pub quote_in: u64,
    pub shares_out: u64,
    pub nav: u128,
    pub owned_quote: u64,
}

#[event]
pub struct SharesRedeemed {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub class: Class,
    pub shares_in: u64,
    pub quote_out: u64,
    pub nav: u128,
    pub owned_quote: u64,
}

#[event]
pub struct HandoffFilled {
    pub vault: Pubkey,
    pub filler: Pubkey,
    /// Positive: the filler sold underlying to the vault.
    pub underlying_delta: i64,
    pub quote_delta: i64,
    pub incentive_paid: u64,
    pub remaining_delta: i128,
    pub owned_underlying: u64,
    pub owned_quote: u64,
}

#[event]
pub struct VaultHalted {
    pub vault: Pubkey,
    pub reason: HaltReason,
    pub ts: i64,
    pub detail: i64,
}

#[event]
pub struct VaultResumed {
    pub vault: Pubkey,
    pub ts: i64,
    pub mark: u128,
    pub exposed: Class,
}

#[event]
pub struct Recapped {
    pub vault: Pubkey,
    pub ts: i64,
    pub from_ts: i64,
    pub to_ts: i64,
    pub boundaries: u32,
    /// Every entry carried a Pyth update from its bell's window.
    pub verified: bool,
    /// Quote atoms charged to the non-exposed class because the exposed one
    /// was wiped. Nonzero only when the operator asked for it.
    pub absorbed: u128,
    /// Loss nobody could pay: both classes at zero.
    pub unabsorbed: u128,
    /// sha256 over the submitted (boundary_ts, mark) pairs, little-endian.
    pub entries_hash: [u8; 32],
    pub exposed: Class,
    pub night_nav: u128,
    pub day_nav: u128,
    pub pending_delta: i128,
    pub funding: i128,
}

#[event]
pub struct ParamsChanged {
    pub vault: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct SurplusSkimmed {
    pub vault: Pubkey,
    pub underlying: u64,
    pub quote: u64,
}

#[cfg(test)]
mod layout {
    use super::*;
    use anchor_lang::AnchorSerialize;

    /// Emit a serialized `Vault` for the SDK decoder to parse.
    ///
    /// Layout drift between a program and its client is a classic production
    /// bug: the client reads a field at the wrong offset, reports a number that
    /// looks plausible, and an operator acts on it. Pinning the bytes makes the
    /// drift a failing test instead.
    #[test]
    fn emit_account_vector() {
        let v = Vault {
            version: VAULT_VERSION,
            bump: 253,
            authority: Pubkey::new_from_array([1u8; 32]),
            pending_authority: Pubkey::new_from_array([2u8; 32]),
            underlying_mint: Pubkey::new_from_array([3u8; 32]),
            quote_mint: Pubkey::new_from_array([4u8; 32]),
            underlying_vault: Pubkey::new_from_array([5u8; 32]),
            quote_vault: Pubkey::new_from_array([6u8; 32]),
            underlying_decimals: 8,
            quote_decimals: 6,
            owned_underlying: 123_456_789,
            owned_quote: 987_654_321,
            night_mint: Pubkey::new_from_array([7u8; 32]),
            day_mint: Pubkey::new_from_array([8u8; 32]),
            mark_feed_id: [9u8; 32],
            equity_feed_id: [10u8; 32],
            night_nav: 1_100_000_000_000_000_000,
            day_nav: 900_000_000_000_000_000,
            last_mark: 2_203_400_000_000_000_000,
            exposed: Class::Day,
            last_session_open: true,
            last_boundary_ts: 1_774_618_201,
            boundary_count: 4_242,
            pending_delta: -191_333,
            funding_k_bps: 2_500,
            funding_max_bps: 50,
            max_stale_secs: 120,
            max_conf_bps: 100,
            max_move_bps: 2_000,
            equity_quiet_secs: 900,
            fill_incentive_bps: 10,
            max_carry_delta_bps: 200,
            max_unexpected_closed_secs: 21_600,
            flags: PAUSE_REDEEM,
            halted: true,
            halt_reason: HaltReason::MissedBoundary,
            cum_funding_night: -55_555,
            cum_fill_incentive: 777,
            total_minted_night: 111_111,
            total_minted_day: 222_222,
            session_kind: SESSION_EVENT,
            symbol: *b"OPENAI\0\0",
            max_posted_slot_age: 4_500,
            max_bell_lead_secs: 300,
            max_premium_bps: 1_000,
            auction_secs: 120,
            incentive_ramp: [10, 25, 50],
            require_verified_recap: true,
            fill_paused_until: 1_774_618_321,
            last_recap_ts: 1_774_500_000,
            recap_count: 3,
            detector_authority: Pubkey::new_from_array([11u8; 32]),
            share_token_program: Pubkey::new_from_array([12u8; 32]),
        };

        let mut body = Vec::new();
        v.serialize(&mut body).unwrap();
        // an on-chain account carries the 8-byte discriminator first
        let mut bytes = Vault::DISCRIMINATOR.to_vec();
        bytes.extend_from_slice(&body);

        assert!(bytes.len() <= Vault::SIZE, "vault exceeds its allocated space");

        let json = format!(
            "{{\n \"note\": \"Generated by `cargo test -p session emit_account_vector`.\",\n\
             \"size\": {},\n \"allocated\": {},\n \"bytes\": {:?}\n}}\n",
            bytes.len(), Vault::SIZE, bytes
        );
        std::fs::create_dir_all("../../tests/vectors").ok();
        std::fs::write("../../tests/vectors/vault-account.json", json).unwrap();
        println!("vault account: {} bytes used of {} allocated", bytes.len(), Vault::SIZE);
    }
}
