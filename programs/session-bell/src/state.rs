//! On-chain accounts.
//!
//! Three kinds, all fixed-size:
//!
//! - **`BellConfig`**, one per deployment: who administers it, which program
//!   verifies Pyth's signatures, and the rule's parameters.
//! - **`Listing`**, one per symbol: which Pyth Pro feeds make up its bell.
//! - **`Print`**, one per listing, trading day and bell: the price, and
//!   everything needed to check it without trusting whoever posted it.
//!
//! A print is written by anyone holding a Pyth-signed message that meets the
//! rule, improved by anyone holding a better one until its deadline, and then
//! frozen for good: `Final` if a price was posted, `Missing` if none was.
//! Nothing ever deletes or rewrites a frozen print.

use anchor_lang::prelude::*;

use crate::lazer::FeedUpdate;

/// Bumped when an account layout changes. An account written by a different
/// version is refused rather than reinterpreted.
pub const BELL_VERSION: u8 = 1;

/// The rule's parameters. Defaults are method v1 (`docs/METHOD.md`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct Params {
    /// Fewest Pyth publishers behind an equity price for it to count. Pyth
    /// itself publishes an aggregate only above a per-feed minimum, which for
    /// US equities is 1 or 2 (SPY, AAPL, QQQ: 1; NVDA, TSLA: 2), so v1 sets
    /// 1 and leaves quality to the confidence bound. It can be raised once
    /// the bells' own records say what the count is at 09:30 and 16:00.
    pub min_publishers: u16,
    /// Widest confidence interval accepted, as basis points of the price.
    pub max_conf_bps: u16,
    /// A close is the last price in `[close − close_lead_secs, close]`.
    pub close_lead_secs: u32,
    /// An open is the first price in `[open, open + open_window_secs]`.
    pub open_window_secs: u32,
    /// Seconds after a window ends during which anyone may post a better
    /// price. At the deadline posting stops and the print can be frozen.
    pub finalize_after_secs: u32,
    /// Token-vs-redemption-value gap beyond which a print is flagged.
    pub max_divergence_bps: u16,
    /// Which written method these parameters implement.
    pub method_version: u16,
}

impl Params {
    pub const V1: Params = Params {
        min_publishers: 1,
        max_conf_bps: 25,
        close_lead_secs: 10,
        open_window_secs: 60,
        finalize_after_secs: 300,
        max_divergence_bps: 300,
        method_version: 1,
    };

    /// Bounds wide enough to tune and narrow enough that no setting turns the
    /// rule into something else: a confidence limit of 100% or a close
    /// window of an hour would be a different oracle, not a looser one.
    pub fn valid(&self) -> bool {
        (1..=100).contains(&self.min_publishers)
            && (1..=1_000).contains(&self.max_conf_bps)
            && (1..=300).contains(&self.close_lead_secs)
            && (1..=900).contains(&self.open_window_secs)
            && (30..=3_600).contains(&self.finalize_after_secs)
            && (1..=10_000).contains(&self.max_divergence_bps)
            && self.method_version >= 1
    }
}

#[account]
#[derive(InitSpace)]
pub struct BellConfig {
    pub version: u8,
    pub bump: u8,
    /// True unless `verifier` is Pyth's own Lazer program. Every print copies
    /// it, so a print verified by a test signer says so forever.
    pub simulated: bool,
    pub admin: Pubkey,
    /// Set by `transfer_admin`, cleared by `accept_admin`.
    pub pending_admin: Pubkey,
    /// The program whose `verify_message` checks Pyth's signature.
    pub verifier: Pubkey,
    /// Its `["storage"]` PDA, where the trusted signers live.
    pub verifier_storage: Pubkey,
    pub params: Params,
    pub listings: u32,
}

impl BellConfig {
    pub const SEED: &'static [u8] = b"bell-config";
    pub const SIZE: usize = 8 + Self::INIT_SPACE + 32;
}

#[account]
#[derive(InitSpace)]
pub struct Listing {
    pub version: u8,
    pub bump: u8,
    pub active: bool,
    /// ASCII, zero-padded: `NVDA`, `BRK.B`.
    pub symbol: [u8; 16],
    /// Pyth Pro feed ids. The equity feed is the print; the others are read
    /// from the same message and kept beside it. 0 = not subscribed.
    pub equity_feed: u32,
    /// Token-per-share redemption rate, e.g. `Crypto.NVDAX/NVDA.RR`.
    pub rr_feed: u32,
    /// The token's own market price, e.g. `Crypto.NVDAX/USD`.
    pub token_feed: u32,
    /// A 24/7 index of the share, e.g. `Equity.Index.NVDA/USD`.
    pub index_feed: u32,
    /// The tokenized share this listing prices, for whoever settles on it.
    pub mint: Pubkey,
    /// Prints opened for this listing, `Missing` ones included.
    pub prints: u64,
    pub missing: u64,
    pub created_at: i64,
    /// When the listing last became active. A bell before it was not this
    /// listing's to record: it can be neither posted nor marked missing, so a
    /// listing registered today cannot be made to show years of missed bells.
    pub active_since: i64,
}

impl Listing {
    pub const SEED: &'static [u8] = b"listing";
    pub const SIZE: usize = 8 + Self::INIT_SPACE + 32;
}

/// One feed's price as the message carried it. Absent fields are zero, and
/// `present` says whether the feed carried a price at all.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, Debug, InitSpace)]
pub struct Quote {
    pub feed_id: u32,
    pub price: i64,
    pub conf: i64,
    pub expo: i16,
    pub publishers: u16,
    /// Pyth's market session: 0 regular, 1 pre, 2 post, 3 overnight,
    /// 4 closed; `SESSION_UNREPORTED` when the message did not say.
    pub session: u8,
    pub present: bool,
    /// When Pyth generated this price, in microseconds.
    pub feed_ts_us: u64,
}

pub const SESSION_UNREPORTED: u8 = u8::MAX;

impl Quote {
    pub fn from_feed(f: &FeedUpdate) -> Quote {
        Quote {
            feed_id: f.feed_id,
            price: f.price.unwrap_or(0),
            conf: f.confidence.unwrap_or(0),
            expo: f.exponent.unwrap_or(0),
            publishers: f.publishers.unwrap_or(0),
            session: f.session.map(|s| s.to_wire() as u8).unwrap_or(SESSION_UNREPORTED),
            present: f.price.is_some(),
            feed_ts_us: f.feed_ts_us.unwrap_or(0),
        }
    }

    /// A subscribed feed the message did not carry.
    pub fn absent(feed_id: u32) -> Quote {
        Quote { feed_id, session: SESSION_UNREPORTED, ..Quote::default() }
    }
}

pub const STATUS_PROVISIONAL: u8 = 0;
pub const STATUS_FINAL: u8 = 1;
pub const STATUS_MISSING: u8 = 2;

/// Verified through a verifier other than Pyth's own program.
pub const FLAG_SIMULATED: u8 = 1 << 0;
/// The redemption rate, token and equity were all present, so
/// `divergence_bps` means something.
pub const FLAG_DIVERGENCE_KNOWN: u8 = 1 << 1;
/// The token was further from its redemption value than
/// `max_divergence_bps` at the bell.
pub const FLAG_DIVERGENT: u8 = 1 << 2;

#[account]
#[derive(InitSpace)]
pub struct Print {
    pub version: u8,
    pub bump: u8,
    pub status: u8,
    /// 0 open, 1 close.
    pub kind: u8,
    pub flags: u8,
    /// The Pyth Pro channel the message came from.
    pub channel: u8,
    /// Accepted posts: the first, then each improvement.
    pub posts: u16,
    pub method_version: u16,
    pub listing: Pubkey,
    /// Eastern-time trading day, as days since 1970-01-01.
    pub day: i64,
    /// The bell itself, unix seconds.
    pub bell_ts: i64,
    /// The window a price had to come from, fixed when the print opened.
    pub window_start_us: u64,
    pub window_end_us: u64,
    /// Posting closes here (unix seconds); freezing opens.
    pub deadline: i64,
    pub equity: Quote,
    pub rr: Quote,
    pub token: Quote,
    pub index: Quote,
    /// (token − equity × rr) / (equity × rr), in basis points. Meaningful only
    /// with `FLAG_DIVERGENCE_KNOWN`.
    pub divergence_bps: i64,
    /// The message's own timestamp, in microseconds.
    pub message_ts_us: u64,
    /// The key that signed the message.
    pub signer: Pubkey,
    /// The program that verified it.
    pub verifier: Pubkey,
    pub poster: Pubkey,
    pub slot: u64,
    pub posted_at: i64,
    pub finalized_at: i64,
}

impl Print {
    pub const SEED: &'static [u8] = b"print";
    pub const SIZE: usize = 8 + Self::INIT_SPACE + 16;
}

/// A symbol is 1–16 of `A–Z 0–9 . -`, zero-padded, with nothing after the
/// first zero.
pub fn valid_symbol(s: &[u8; 16]) -> bool {
    let len = s.iter().position(|&b| b == 0).unwrap_or(16);
    len > 0
        && s[..len].iter().all(|&b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
        && s[len..].iter().all(|&b| b == 0)
}

/// The equity feed is required; the others are optional, and no feed may
/// appear twice.
pub fn valid_feeds(equity: u32, rr: u32, token: u32, index: u32) -> bool {
    let set = [equity, rr, token, index];
    equity != 0
        && set.iter().enumerate().all(|(i, a)| *a == 0 || set[..i].iter().all(|b| b != a))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sym(s: &str) -> [u8; 16] {
        let mut out = [0u8; 16];
        out[..s.len()].copy_from_slice(s.as_bytes());
        out
    }

    #[test]
    fn symbols() {
        assert!(valid_symbol(&sym("NVDA")));
        assert!(valid_symbol(&sym("BRK.B")));
        assert!(valid_symbol(&sym("ABCDEFGHIJKLMNOP")));
        assert!(!valid_symbol(&sym("")));
        assert!(!valid_symbol(&sym("nvda")));
        assert!(!valid_symbol(&sym("NV DA")));
        let mut gap = sym("NV");
        gap[3] = b'A';
        assert!(!valid_symbol(&gap), "bytes after the first zero");
    }

    #[test]
    fn feeds() {
        assert!(valid_feeds(1314, 1832, 1833, 3188));
        assert!(valid_feeds(1314, 0, 0, 0));
        assert!(valid_feeds(1314, 0, 1833, 0));
        assert!(!valid_feeds(0, 1832, 1833, 3188), "the equity feed is the print");
        assert!(!valid_feeds(1314, 1314, 0, 0));
        assert!(!valid_feeds(1314, 1833, 1833, 0));
    }

    #[test]
    fn v1_params_are_within_their_own_bounds() {
        assert!(Params::V1.valid());
        assert!(!Params { finalize_after_secs: 0, ..Params::V1 }.valid());
        assert!(!Params { max_conf_bps: 10_000, ..Params::V1 }.valid());
        assert!(!Params { close_lead_secs: 3_600, ..Params::V1 }.valid());
        assert!(!Params { method_version: 0, ..Params::V1 }.valid());
    }

    /// A realistic print, for the layout vector.
    pub(crate) fn sample() -> Print {
        let q = |feed_id: u32, price: i64, expo: i16, ts: u64| Quote {
            feed_id,
            price,
            conf: 1_100_000,
            expo,
            publishers: 9,
            session: 0,
            present: true,
            feed_ts_us: ts,
        };
        Print {
            version: BELL_VERSION,
            bump: 254,
            status: STATUS_FINAL,
            kind: 1,
            flags: FLAG_SIMULATED | FLAG_DIVERGENCE_KNOWN,
            channel: 3,
            posts: 7,
            method_version: 1,
            listing: Pubkey::new_from_array([1u8; 32]),
            day: 20_720,
            bell_ts: 1_790_280_000,
            window_start_us: 1_790_279_990_000_000,
            window_end_us: 1_790_280_000_000_000,
            deadline: 1_790_280_300,
            equity: q(1314, 22_406_000_000, -8, 1_790_279_999_800_000),
            rr: q(1832, 100_170_000, -8, 1_790_279_999_900_000),
            token: q(1833, 22_441_000_000, -8, 1_790_279_999_950_000),
            index: Quote::absent(3188),
            divergence_bps: -22,
            message_ts_us: 1_790_280_000_000_000,
            signer: Pubkey::new_from_array([2u8; 32]),
            verifier: Pubkey::new_from_array([3u8; 32]),
            poster: Pubkey::new_from_array([4u8; 32]),
            slot: 412_345_678,
            posted_at: 1_790_280_001,
            finalized_at: 1_790_280_301,
        }
    }

    /// Pins the byte layout the SDK decodes. `tests/bell.test.ts` reads it.
    #[test]
    fn emit_account_vector() {
        let p = sample();
        let mut body = Vec::new();
        p.serialize(&mut body).unwrap();
        let mut bytes = Print::DISCRIMINATOR.to_vec();
        bytes.extend_from_slice(&body);
        assert!(bytes.len() <= Print::SIZE, "print exceeds its allocated space");

        let json = format!(
            "{{\n \"note\": \"Generated by `cargo test -p session-bell emit_account_vector`.\",\n\
             \"size\": {},\n \"allocated\": {},\n \"bytes\": {:?}\n}}\n",
            bytes.len(),
            Print::SIZE,
            bytes
        );
        std::fs::create_dir_all("../../tests/vectors").ok();
        std::fs::write("../../tests/vectors/print-account.json", json).unwrap();
        println!("print account: {} bytes used of {} allocated", bytes.len(), Print::SIZE);
    }
}
