//! The pure arithmetic every SESSION program settles on.
//!
//! Shared rather than copied:
//!
//! - [`calendar`] — the NYSE session calendar: holidays, half-days, DST and
//!   Good Friday by computus, in integer arithmetic with no timezone
//!   database. It decides when a bell rings, which decides who is paid.
//! - [`fixed`] — WAD fixed point and a 256-bit `mul_div`, because the naive
//!   `u128` path overflows on ordinary price × quantity.
//! - [`xstock`] — what one raw atom of an xStock is worth: the share price
//!   times the mint's own multiplier, read from its bytes exactly.
//! - [`cross`] — netting at the bell's price and the uniform-price auction
//!   for the difference, with every rounding in escrow's favour.
//!
//! `programs/session` settles a vault's classes on these; `programs/session-bell`
//! decides which instant a print belongs to with the same calendar. A second
//! copy of either would be free to drift from the first, and the difference
//! would be money in the wrong place. `tests/vectors/calendar.json` pins the
//! calendar to `sdk/src/calendar.ts`; `tests/pyth-schedule.check.ts` holds it
//! against the schedule Pyth publishes.
//!
//! No dependencies and no `unsafe`: whatever links this crate gets exactly
//! these answers and nothing that could change them.

#![forbid(unsafe_code)]

pub mod calendar;
pub mod cross;
pub mod fixed;
pub mod xstock;
