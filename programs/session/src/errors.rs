use anchor_lang::prelude::*;

#[error_code]
pub enum SessionError {
    #[msg("vault is paused")]
    Paused,
    #[msg("no session boundary has occurred yet")]
    NoBoundary,
    #[msg("a class may only be minted or redeemed while it is parked in quote")]
    ClassNotParked,
    #[msg("oracle price is stale")]
    StaleOracle,
    #[msg("oracle confidence interval is too wide to settle against")]
    UncertainOracle,
    #[msg("price moved further since the last boundary than the vault will accept")]
    MoveTooLarge,
    #[msg("oracle price is not positive")]
    BadOraclePrice,
    #[msg("oracle exponent out of range")]
    BadExponent,
    #[msg("price update does not match the configured feed id")]
    WrongFeed,
    #[msg("fixed point overflow")]
    MathOverflow,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("there is no imbalance to fill")]
    NothingToFill,
    #[msg("fill is on the wrong side of the imbalance")]
    WrongFillSide,
    #[msg("fill would overshoot the outstanding imbalance")]
    FillTooLarge,
    #[msg("slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("parameter out of range")]
    BadParameter,
}
