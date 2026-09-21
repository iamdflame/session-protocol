//! Recap: replaying the boundaries a halted vault missed.
//!
//! A vault that misses two bells halts, because the mark at the first of
//! them is gone and settling from the second alone would pay a whole session
//! to the wrong class. The previous remedy was `resolve_halt`, which set
//! `last_boundary_ts = now` and carried on — silently deciding that nobody was
//! owed anything for the missed sessions. That is discretion over other
//! people's NAV, and the operator did not even have to say so.
//!
//! A recap is the alternative. The operator supplies one mark per missed
//! boundary; the program decides which boundaries those are, from the same
//! calendar the live path uses, and applies each one with the same `settle()`
//! the live path runs. The operator chooses nothing but the prices, every
//! price is bounded, and each one may be backed by a Pyth update from that
//! bell's own window, in which case the operator chose nothing at all.
//!
//! What a recap refuses to do is absorb a loss into the wrong class. If a
//! replayed boundary wipes the exposed class, the replay stops — unless the
//! operator explicitly asks for the remainder to be charged to the other
//! class, which is the only place it can go, and that is written into the
//! receipt.

use crate::calendar::Session;
use crate::fixed::{mul_div_ceil, mul_div_floor, WAD};
use crate::funding::FundingParams;
use crate::machine::{decide, Decision};
use crate::settle::{settle, value_of, NavState, ShareClass};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RecapError {
    /// No entries.
    Empty,
    /// An entry's timestamp is not the next boundary the calendar produces
    /// from the previous one, or the vault's tracked session disagrees with
    /// the calendar there.
    Mismatch,
    /// An entry lies in the future.
    Future,
    /// An attested (not Pyth-backed) mark moved further than the vault
    /// accepts on the operator's word.
    MoveTooLarge,
    /// A replayed boundary produced a loss the exposed class could not cover
    /// and the caller did not ask to absorb it.
    Shortfall,
    /// A mark of zero.
    ZeroMark,
    Overflow,
}

#[derive(Clone, Copy, Debug)]
pub struct Entry {
    pub boundary_ts: i64,
    /// Quote atoms per underlying atom, WAD-scaled — the same units as
    /// `Vault::last_mark`.
    pub mark: u128,
    /// Whether a Pyth update from this bell's window backed the mark. A
    /// verified mark is not subject to the move bound: Pyth said so.
    pub verified: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct Input<'a> {
    pub last_session: Session,
    pub last_boundary_ts: i64,
    pub state: NavState,
    pub pending_delta: i128,
    pub funding: FundingParams,
    pub max_move_bps: u16,
    /// Charge any shortfall to the other class instead of refusing.
    pub absorb_shortfall: bool,
    pub now: i64,
    pub entries: &'a [Entry],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Output {
    pub night_nav: u128,
    pub day_nav: u128,
    pub exposed: ShareClass,
    pub last_mark: u128,
    pub last_session: Session,
    pub last_boundary_ts: i64,
    pub pending_delta: i128,
    /// Net funding over the replay, NIGHT → DAY positive.
    pub funding: i128,
    pub boundaries: u32,
    /// Quote atoms charged to the non-exposed class because the exposed one
    /// was wiped. Zero unless `absorb_shortfall` and a wipe occurred.
    pub absorbed: u128,
    /// Loss that could not be charged to anyone: both classes are at zero.
    pub unabsorbed: u128,
}

/// Replay `entries` in order from the vault's tracked position.
pub fn replay(i: &Input) -> Result<Output, RecapError> {
    if i.entries.is_empty() {
        return Err(RecapError::Empty);
    }

    let mut session = i.last_session;
    let mut prev_ts = i.last_boundary_ts;
    let mut s = i.state;
    let mut pending = i.pending_delta;
    let mut funding: i128 = 0;
    let mut absorbed: u128 = 0;
    let mut unabsorbed: u128 = 0;

    for e in i.entries {
        if e.boundary_ts > i.now {
            return Err(RecapError::Future);
        }
        if e.mark == 0 {
            return Err(RecapError::ZeroMark);
        }

        // The calendar, not the operator, says which boundary comes next.
        // `decide` at exactly the entry's instant must see precisely one
        // elapsed boundary and it must be this one.
        let to = match decide(session, prev_ts, e.boundary_ts) {
            Decision::Settle { to, at } if at == e.boundary_ts => to,
            _ => return Err(RecapError::Mismatch),
        };

        if !e.verified && s.last_mark > 0 {
            let diff = if e.mark > s.last_mark { e.mark - s.last_mark } else { s.last_mark - e.mark };
            let bps = mul_div_floor(diff, 10_000, s.last_mark).ok_or(RecapError::Overflow)?;
            if bps > i.max_move_bps as u128 {
                return Err(RecapError::MoveTooLarge);
            }
        }

        let out = settle(&s, e.mark, &i.funding).map_err(|_| RecapError::Overflow)?;
        let (mut night_nav, mut day_nav) = (out.night_nav, out.day_nav);

        if out.shortfall > 0 {
            if !i.absorb_shortfall {
                return Err(RecapError::Shortfall);
            }
            // The exposed class is already at zero inside `out`. The
            // remainder can only come from the other class; round the charge
            // up so claims never exceed assets.
            let (other_supply, other_nav) = match s.exposed {
                ShareClass::Night => (s.day_supply, &mut day_nav),
                ShareClass::Day => (s.night_supply, &mut night_nav),
            };
            let other_value = value_of(other_supply, *other_nav).ok_or(RecapError::Overflow)?;
            if other_supply == 0 || out.shortfall >= other_value {
                absorbed = absorbed.saturating_add(other_value);
                unabsorbed = unabsorbed.saturating_add(out.shortfall - other_value.min(out.shortfall));
                *other_nav = 0;
            } else {
                let charge = mul_div_ceil(out.shortfall, WAD, other_supply as u128)
                    .ok_or(RecapError::Overflow)?;
                *other_nav = other_nav.saturating_sub(charge);
                absorbed = absorbed.saturating_add(out.shortfall);
            }
        }

        s = NavState {
            night_supply: s.night_supply,
            day_supply: s.day_supply,
            owned_underlying: s.owned_underlying,
            night_nav,
            day_nav,
            exposed: out.exposed,
            last_mark: e.mark,
        };
        pending = pending.checked_add(out.handoff_delta).ok_or(RecapError::Overflow)?;
        funding = funding.checked_add(out.funding).ok_or(RecapError::Overflow)?;
        session = to;
        prev_ts = e.boundary_ts;
    }

    Ok(Output {
        night_nav: s.night_nav,
        day_nav: s.day_nav,
        exposed: s.exposed,
        last_mark: s.last_mark,
        last_session: session,
        last_boundary_ts: prev_ts,
        pending_delta: pending,
        funding,
        boundaries: i.entries.len() as u32,
        absorbed,
        unabsorbed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::{days_from_civil, SEC_PER_DAY};
    use proptest::prelude::*;

    // 2026-09-18 is a Friday, 2026-09-21 a Monday; EDT, so ET = UTC-4.
    fn fri(h: i64, m: i64) -> i64 {
        days_from_civil(2026, 9, 18) * SEC_PER_DAY + (h + 4) * 3600 + m * 60
    }
    fn mon(h: i64, m: i64) -> i64 {
        days_from_civil(2026, 9, 21) * SEC_PER_DAY + (h + 4) * 3600 + m * 60
    }

    const FP: FundingParams = FundingParams::new(2_500, 50);

    fn balanced(mark: u128) -> NavState {
        // 1,000 shares a side at parity, inventory sized to the exposed class
        let supply = 1_000_000_000u64;
        NavState {
            night_supply: supply,
            day_supply: supply,
            owned_underlying: (supply as u128 * WAD / mark) as u64,
            night_nav: WAD,
            day_nav: WAD,
            exposed: ShareClass::Day,
            last_mark: mark,
        }
    }

    /// Settled at Friday's open, missed the close and Monday's open, cranked
    /// Monday noon. A recap of the two bells lands exactly where two on-time
    /// settlements would have.
    #[test]
    fn a_missed_weekend_replays_to_the_uninterrupted_result() {
        let m0 = 2_200_000_000_000_000_000u128;
        let m1 = 2_250_000_000_000_000_000u128; // Friday close
        let m2 = 2_180_000_000_000_000_000u128; // Monday open: a gap down over the weekend
        let start = balanced(m0);

        // the live path, twice
        let a = settle(&start, m1, &FP).unwrap();
        let mid = NavState { night_nav: a.night_nav, day_nav: a.day_nav, exposed: a.exposed, last_mark: m1, ..start };
        let b = settle(&mid, m2, &FP).unwrap();

        let out = replay(&Input {
            last_session: Session::Open,
            last_boundary_ts: fri(9, 30),
            state: start,
            pending_delta: 0,
            funding: FP,
            max_move_bps: 2_000,
            absorb_shortfall: false,
            now: mon(12, 0),
            entries: &[
                Entry { boundary_ts: fri(16, 0), mark: m1, verified: false },
                Entry { boundary_ts: mon(9, 30), mark: m2, verified: false },
            ],
        })
        .unwrap();

        assert_eq!(out.night_nav, b.night_nav);
        assert_eq!(out.day_nav, b.day_nav);
        assert_eq!(out.exposed, b.exposed);
        assert_eq!(out.last_mark, m2);
        assert_eq!(out.last_session, Session::Open);
        assert_eq!(out.last_boundary_ts, mon(9, 30));
        assert_eq!(out.pending_delta, a.handoff_delta + b.handoff_delta);
        assert_eq!(out.funding, a.funding + b.funding);
        assert_eq!(out.boundaries, 2);
        assert_eq!(out.absorbed, 0);
        // NIGHT wore the weekend gap, DAY did not
        assert!(out.night_nav < WAD, "night {}", out.night_nav);
        assert!(out.day_nav > WAD, "day {}", out.day_nav);
    }

    fn base_input<'a>(entries: &'a [Entry]) -> Input<'a> {
        Input {
            last_session: Session::Open,
            last_boundary_ts: fri(9, 30),
            state: balanced(2_200_000_000_000_000_000),
            pending_delta: 0,
            funding: FP,
            max_move_bps: 2_000,
            absorb_shortfall: false,
            now: mon(12, 0),
            entries,
        }
    }

    #[test]
    fn the_operator_cannot_choose_the_boundaries() {
        let m = 2_200_000_000_000_000_000u128;
        // skipping Friday's close
        let skip = [Entry { boundary_ts: mon(9, 30), mark: m, verified: false }];
        assert_eq!(replay(&base_input(&skip)), Err(RecapError::Mismatch));
        // a timestamp that is not a bell at all
        let off = [Entry { boundary_ts: fri(16, 1), mark: m, verified: false }];
        assert_eq!(replay(&base_input(&off)), Err(RecapError::Mismatch));
        // the same bell twice
        let twice = [
            Entry { boundary_ts: fri(16, 0), mark: m, verified: false },
            Entry { boundary_ts: fri(16, 0), mark: m, verified: false },
        ];
        assert_eq!(replay(&base_input(&twice)), Err(RecapError::Mismatch));
        // a bell that has not rung yet
        let mut fut = base_input(&off);
        let e = [Entry { boundary_ts: fri(16, 0), mark: m, verified: false }];
        fut.entries = &e;
        fut.now = fri(15, 0);
        assert_eq!(replay(&fut), Err(RecapError::Future));
        assert_eq!(replay(&base_input(&[])), Err(RecapError::Empty));
    }

    #[test]
    fn an_attested_mark_is_bounded_and_a_verified_one_is_not() {
        let jump = 2_200_000_000_000_000_000u128 * 13 / 10; // +30%
        let attested = [Entry { boundary_ts: fri(16, 0), mark: jump, verified: false }];
        assert_eq!(replay(&base_input(&attested)), Err(RecapError::MoveTooLarge));
        let verified = [Entry { boundary_ts: fri(16, 0), mark: jump, verified: true }];
        assert!(replay(&base_input(&verified)).is_ok());
    }

    /// An over-hedged vault (inventory far larger than the exposed class)
    /// takes a loss the class cannot cover. Without consent the replay
    /// refuses; with it, the other class is charged exactly the remainder and
    /// the books still balance.
    #[test]
    fn a_wipe_is_refused_unless_absorbed_and_then_charged_exactly() {
        let m0 = 2_200_000_000_000_000_000u128;
        let mut s = balanced(m0);
        s.owned_underlying *= 8; // badly over-hedged: eight times the inventory the class backs
        let crash = m0 * 8 / 10; // -20%
        let entries = [Entry { boundary_ts: fri(16, 0), mark: crash, verified: true }];
        let mut i = base_input(&entries);
        i.state = s;
        assert_eq!(replay(&i), Err(RecapError::Shortfall));

        i.absorb_shortfall = true;
        let out = replay(&i).unwrap();
        assert_eq!(out.day_nav, 0, "the exposed class is wiped");
        assert!(out.night_nav < WAD, "the other class wore the remainder");
        assert!(out.absorbed > 0 && out.unabsorbed == 0);

        // the charge is the shortfall, rounded against the class
        let live = settle(&s, crash, &FP).unwrap();
        let charge = mul_div_ceil(live.shortfall, WAD, s.night_supply as u128).unwrap();
        // funding also moved NAV in `live`; compare against the post-funding figure
        assert_eq!(out.night_nav, live.night_nav.saturating_sub(charge));
        assert_eq!(out.absorbed, live.shortfall);
    }

    #[test]
    fn a_loss_larger_than_both_classes_leaves_a_recorded_remainder() {
        let m0 = 2_200_000_000_000_000_000u128;
        let mut s = balanced(m0);
        s.owned_underlying *= 40;
        let crash = m0 / 2;
        let entries = [Entry { boundary_ts: fri(16, 0), mark: crash, verified: true }];
        let mut i = base_input(&entries);
        i.state = s;
        i.absorb_shortfall = true;
        let out = replay(&i).unwrap();
        assert_eq!((out.night_nav, out.day_nav), (0, 0));
        assert!(out.unabsorbed > 0, "the part nobody could pay is written down, not hidden");
    }

    proptest! {
        /// For any marks within the move bound, replaying n boundaries equals
        /// settling them one at a time on the live path.
        #[test]
        fn replay_equals_sequential_settlement(
            marks in proptest::collection::vec(1_500_000_000_000_000_000u128..2_900_000_000_000_000_000u128, 1..6),
            night in 1_000_000u64..2_000_000_000u64,
            day in 1_000_000u64..2_000_000_000u64,
        ) {
            let m0 = 2_200_000_000_000_000_000u128;
            let start = NavState {
                night_supply: night, day_supply: day,
                owned_underlying: (day as u128 * WAD / m0) as u64,
                night_nav: WAD, day_nav: WAD, exposed: ShareClass::Day, last_mark: m0,
            };
            // walk the calendar from Friday's open for as many bells as marks
            let mut ts = fri(9, 30);
            let mut entries = Vec::new();
            let mut state = start;
            let mut pending: i128 = 0;
            let mut ok = true;
            for &m in &marks {
                let b = crate::calendar::next_boundary(ts, 12).unwrap();
                entries.push(Entry { boundary_ts: b, mark: m, verified: true });
                ts = b;
                match settle(&state, m, &FP) {
                    Ok(out) if out.shortfall == 0 => {
                        pending += out.handoff_delta;
                        state = NavState { night_nav: out.night_nav, day_nav: out.day_nav, exposed: out.exposed, last_mark: m, ..state };
                    }
                    _ => { ok = false; break; }
                }
            }
            let out = replay(&Input {
                last_session: Session::Open, last_boundary_ts: fri(9, 30), state: start,
                pending_delta: 0, funding: FP, max_move_bps: 9_000, absorb_shortfall: false,
                now: ts + 1, entries: &entries,
            });
            if ok {
                let out = out.unwrap();
                prop_assert_eq!(out.night_nav, state.night_nav);
                prop_assert_eq!(out.day_nav, state.day_nav);
                prop_assert_eq!(out.exposed, state.exposed);
                prop_assert_eq!(out.pending_delta, pending);
                prop_assert_eq!(out.last_boundary_ts, ts);
            } else {
                prop_assert_eq!(out, Err(RecapError::Shortfall));
            }
        }
    }
}
