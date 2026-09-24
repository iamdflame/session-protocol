//! Nothing here: the harness is its `tests/`. Cargo wants a target, and a
//! library with no items is the smallest one.
//!
//! - `tests/smoke.rs`   LiteSVM runs on this machine and loads Pyth's verifier.
//! - `tests/bell.rs`    session-bell end to end against that verifier.
//! - `tests/vectors.rs` writes `tests/vectors/lazer.json` with Pyth's encoder.
