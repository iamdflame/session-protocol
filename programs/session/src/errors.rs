use anchor_lang::prelude::*;

/// Errors are deliberately specific. A single generic failure would make an
/// operator guess which of a dozen guards fired, and guessing is exactly what
/// this program is built to avoid.
#[error_code]
pub enum SessionError {
    // ── lifecycle ────────────────────────────────────────────────────────
    #[msg("vault is halted and needs an operator")]
    Halted,
    #[msg("vault is not halted")]
    NotHalted,
    #[msg("acknowledged halt reason does not match the current one")]
    HaltReasonMismatch,
    #[msg("this operation is paused")]
    Paused,
    #[msg("vault account was written by a different program version")]
    VersionMismatch,
    #[msg("caller is not the vault authority")]
    Unauthorized,
    #[msg("this field cannot be changed after initialization")]
    ImmutableField,

    // ── state machine ────────────────────────────────────────────────────
    #[msg("no session boundary has elapsed")]
    NoBoundary,
    #[msg("a class may only be minted or redeemed while it is parked in quote")]
    ClassNotParked,

    // ── oracle ───────────────────────────────────────────────────────────
    #[msg("price update account is not owned by the Pyth receiver")]
    WrongOracleOwner,
    #[msg("account is not a Pyth price update")]
    NotAPriceUpdate,
    #[msg("price update account is malformed or truncated")]
    MalformedPriceUpdate,
    #[msg("price update does not match the configured feed id")]
    WrongFeed,
    #[msg("oracle price is stale")]
    StaleOracle,
    #[msg("oracle confidence interval is too wide to settle against")]
    UncertainOracle,
    #[msg("price moved further since the last boundary than the vault accepts")]
    MoveTooLarge,
    #[msg("oracle price is not positive")]
    BadOraclePrice,
    #[msg("oracle exponent out of range")]
    BadExponent,

    // ── accounting ───────────────────────────────────────────────────────
    #[msg("assets would no longer cover claims")]
    Insolvent,
    #[msg("net asset value has collapsed to zero")]
    NavCollapsed,
    #[msg("fixed point overflow")]
    MathOverflow,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("amount rounds to zero at the current NAV")]
    AmountTooSmall,
    #[msg("account mint does not match the vault")]
    WrongMint,

    // ── handoff ──────────────────────────────────────────────────────────
    #[msg("there is no imbalance to fill")]
    NothingToFill,
    #[msg("fill would overshoot the outstanding imbalance")]
    FillTooLarge,
    #[msg("slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("vault does not hold enough quote for this fill")]
    InsufficientQuote,
    #[msg("vault does not hold enough underlying for this fill")]
    InsufficientUnderlying,
    #[msg("quote is reserved for a pending handoff and cannot be paid out")]
    InsufficientFreeQuote,
    #[msg("no class holds shares to charge the fill incentive to")]
    NoFeePayer,
    #[msg("there is no surplus to skim")]
    NothingToSkim,

    // ── configuration ────────────────────────────────────────────────────
    #[msg("parameter out of range")]
    BadParameter,

    // ── appended, never inserted ─────────────────────────────────────────
    // Anchor assigns error codes by declaration order, so a new variant goes
    // at the end. Inserting one above renumbers everything after it and every
    // client that maps a code to a message starts lying.
    #[msg("price update is only partially verified; a fully verified update is required")]
    PartialVerification,
    #[msg("token account is not owned by the signer")]
    WrongOwner,
    #[msg("price update account was posted too many slots ago")]
    PostedSlotStale,
    #[msg("mark publish time is outside the window this instruction accepts")]
    MarkOutsideWindow,
    #[msg("boundaries are unaccounted for; recap them before resuming")]
    RecapRequired,
    #[msg("recap entry is not the next boundary the calendar produces, lies in the future, or does not match its Pyth update")]
    RecapMismatch,
    #[msg("a replayed boundary wiped the exposed class; absorb_shortfall must be set to charge the remainder to the other class")]
    RecapShortfall,
    #[msg("this vault requires a Pyth update for every recapped boundary")]
    RecapUnverified,
    #[msg("a vault halted for an inconsistency cannot be recapped or resumed")]
    RecapNotApplicable,
    #[msg("handoff residue exceeds the carry limit; fill it before resuming")]
    ResidueTooLarge,
    #[msg("the underlying's issuer has set a transfer hook, paused the mint, or frozen or emptied the vault's token account")]
    IssuerAction,
    #[msg("account is not a mint this program can read")]
    NotAMint,
    #[msg("the underlying that arrived does not match the mint's transfer-fee schedule")]
    TransferFeeMismatch,
    #[msg("fills are paused for a cooling period after a jump settled")]
    FillsPaused,
    #[msg("token program does not match the one this vault's accounts live under")]
    WrongTokenProgram,
    #[msg("this vault is not an event session")]
    NotEventSession,
    #[msg("the detector reading is too old to act on")]
    DetectorStale,
    #[msg("an event session needs its schedule and detector accounts")]
    MissingEventAccounts,
    #[msg("account belongs to a different vault")]
    WrongVault,
}
