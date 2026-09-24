use anchor_lang::prelude::*;

/// One variant per refusal, so a failed order or crank says which rule it broke.
#[error_code]
pub enum CrossError {
    // ── administration ───────────────────────────────────────────────────
    #[msg("only the program's upgrade authority may create the config")]
    NotUpgradeAuthority,
    #[msg("caller is not the admin")]
    Unauthorized,
    #[msg("caller is not the pending admin")]
    NotPendingAdmin,
    #[msg("market parameters outside their bounds")]
    BadParams,
    #[msg("account written by a different program version")]
    VersionMismatch,
    #[msg("the listing prices a different mint")]
    ListingMintMismatch,

    // ── the mint ─────────────────────────────────────────────────────────
    #[msg("not a well-formed token mint")]
    NotAMint,
    #[msg("the issuer has paused, hooked or fee'd this mint: no new escrow")]
    MintRefusesEscrow,
    #[msg("account is not the market's")]
    WrongAccount,

    // ── orders ───────────────────────────────────────────────────────────
    #[msg("market is not taking new orders")]
    MarketInactive,
    #[msg("no bell on that day")]
    NoBell,
    #[msg("side must be 0 (buy) or 1 (sell)")]
    BadSide,
    #[msg("the book is frozen: the bell is too close")]
    Frozen,
    #[msg("the cross is no longer collecting orders")]
    NotCollecting,
    #[msg("order is smaller than the market minimum")]
    OrderTooSmall,
    #[msg("this side of the cross is full")]
    SideFull,
    #[msg("caller does not own this order")]
    NotOwner,

    // ── the price ────────────────────────────────────────────────────────
    #[msg("the print is not this cross's")]
    WrongPrint,
    #[msg("the print is not final yet")]
    PrintNotFinal,
    #[msg("this market does not accept prints from a test signer")]
    SimulatedPrint,
    #[msg("too early to cancel: the print may still come")]
    TooEarlyToCancel,

    // ── the book and the auction ─────────────────────────────────────────
    #[msg("the cross is not confirming orders")]
    NotConfirming,
    #[msg("order belongs to another cross")]
    WrongCross,
    #[msg("the auction is not open")]
    AuctionClosed,
    #[msg("the auction has not ended")]
    AuctionOpen,
    #[msg("offer must be on the crowded side")]
    WrongSide,
    #[msg("fee above the market's maximum")]
    FeeTooHigh,

    // ── settlement ───────────────────────────────────────────────────────
    #[msg("the cross is not settling")]
    NotSettling,
    #[msg("not the owner's associated token account")]
    WrongDestination,
    #[msg("settlement would take more out of escrow than this cross put in")]
    EscrowOverdrawn,
    #[msg("every order and offer must settle before the cross closes")]
    Unsettled,
    #[msg("arithmetic overflow")]
    Overflow,
}
