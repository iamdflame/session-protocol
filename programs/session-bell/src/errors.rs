use anchor_lang::prelude::*;

use crate::lazer::LazerError;
use crate::rules::Reject;

/// One variant per refusal, so a failed post says which rule it broke.
#[error_code]
pub enum BellError {
    // ── administration ───────────────────────────────────────────────────
    #[msg("only the program's upgrade authority may create the config")]
    NotUpgradeAuthority,
    #[msg("caller is not the admin")]
    Unauthorized,
    #[msg("caller is not the pending admin")]
    NotPendingAdmin,
    #[msg("parameters outside their bounds")]
    BadParams,
    #[msg("verifier storage is not the verifier's [\"storage\"] account")]
    WrongVerifierStorage,
    #[msg("account written by a different program version")]
    VersionMismatch,

    // ── listings ─────────────────────────────────────────────────────────
    #[msg("symbol must be 1-16 of A-Z 0-9 . - then zero padding")]
    BadSymbol,
    #[msg("equity feed required; no feed may repeat")]
    BadFeeds,
    #[msg("listing is not active")]
    ListingInactive,
    #[msg("listing was not active at that bell")]
    NotListedAtBell,

    // ── the bell ─────────────────────────────────────────────────────────
    #[msg("kind must be 0 (open) or 1 (close)")]
    BadKind,
    #[msg("no bell on that day")]
    NoBell,
    #[msg("posting for this bell has closed")]
    PostingClosed,
    #[msg("print is already final or missing")]
    PrintClosed,
    #[msg("too early: the print's deadline has not passed")]
    TooEarly,
    #[msg("not better than the stored print")]
    NotBetter,

    // ── the message ──────────────────────────────────────────────────────
    #[msg("verifier account is not the configured verifier")]
    WrongVerifier,
    #[msg("not a Solana-format Pyth Pro message")]
    BadMessage,
    #[msg("Pyth Pro payload could not be read")]
    BadPayload,
    #[msg("verifier returned no verified message")]
    NoVerification,
    #[msg("verified message differs from the one posted")]
    VerificationMismatch,
    #[msg("message does not carry the listing's equity feed")]
    FeedMissing,

    // ── the rule ─────────────────────────────────────────────────────────
    #[msg("message lacks a property the rule reads")]
    MissingProperty,
    #[msg("price is not positive")]
    NonPositivePrice,
    #[msg("exponent outside [-18, 12]")]
    BadExponent,
    #[msg("fewer publishers than the rule requires")]
    TooFewPublishers,
    #[msg("price is not from the regular session")]
    NotRegularSession,
    #[msg("confidence interval wider than the rule allows")]
    ConfidenceTooWide,
    #[msg("price is not from the bell's window")]
    OutsideWindow,
    #[msg("feed timestamp is later than the message's")]
    FeedAfterMessage,
    #[msg("price is dated later than the chain's clock allows")]
    FeedFromTheFuture,
}

/// The envelope failed to parse. Mapped at the call site rather than by
/// variant: a truncation in the envelope and one in the payload are
/// different faults.
pub fn bad_message(e: LazerError) -> BellError {
    msg!("pyth pro message: {:?}", e);
    BellError::BadMessage
}

pub fn bad_payload(e: LazerError) -> BellError {
    msg!("pyth pro payload: {:?}", e);
    BellError::BadPayload
}

impl From<Reject> for BellError {
    fn from(r: Reject) -> Self {
        match r {
            Reject::Missing(what) => {
                msg!("missing property: {}", what);
                BellError::MissingProperty
            }
            Reject::NonPositivePrice => BellError::NonPositivePrice,
            Reject::BadExponent => BellError::BadExponent,
            Reject::TooFewPublishers => BellError::TooFewPublishers,
            Reject::NotRegularSession => BellError::NotRegularSession,
            Reject::ConfidenceTooWide => BellError::ConfidenceTooWide,
            Reject::OutsideWindow => BellError::OutsideWindow,
            Reject::FeedAfterMessage => BellError::FeedAfterMessage,
        }
    }
}
