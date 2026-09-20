//! SESSION — splitting a tokenized equity into the hours arbitrage works
//! and the hours it does not.
//!
//! A tokenized share trades 24/7, but the stock behind it only trades for 6.5
//! hours a day. During those hours an arbitrageur can hedge the token against
//! the real share and the two stay pinned together. Outside them nobody can,
//! and the token is free to drift.
//!
//! Those are two genuinely different assets wearing one ticker. This program
//! separates them.

pub mod calendar;
pub mod fixed;
pub mod funding;
pub mod settle;
