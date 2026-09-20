//! The session state machine.
//!
//! The original program inferred exposure from the current session: it settled
//! whenever `class_for(session_at(now)) != vault.exposed`. That cannot tell
//! "nothing has happened" apart from "two things have happened and we are back
//! where we started", and the difference is an entire session's return.
//!
//! ```text
//!   Fri 16:00  close      NIGHT should take over    [crank missed]
//!   Mon 09:30  open       DAY should take over
//!   Mon 12:00  crank      session=Open, exposed=Day  ->  "no boundary"
//! ```
//!
//! DAY silently keeps the whole 65.5-hour weekend, including every gap, and
//! NIGHT — the class that exists to hold exactly that risk — earns nothing. No
//! error is raised and the corruption is permanent.
//!
//! So the session is now *tracked*, never inferred, and the number of elapsed
//! boundaries is counted. One is recoverable. Two is not: the mark at the
//! intermediate boundary is gone, and no price available now can reconstruct who
//! was owed what. The vault halts instead of guessing.

use crate::calendar::{boundaries_between, session_at, Session};

/// The most boundaries worth counting. Beyond this the vault is halting anyway,
/// so the exact number is only useful for the operator's alert.
pub const BOUNDARY_SCAN_CAP: u32 = 24;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Decision {
    /// The session has not changed since the last settlement.
    UpToDate,
    /// Exactly one boundary elapsed. Settle into `to`.
    Settle { to: Session },
    /// Two or more boundaries elapsed. Settling now would attribute a whole
    /// session to the wrong class, so the vault must halt for an operator.
    Stale { missed: u32 },
    /// The tracked session and the elapsed-boundary count disagree — the
    /// calendar cannot produce this, so the account is corrupt or was written
    /// by a different program version.
    Inconsistent,
}

/// Decide what a crank at `now` should do.
///
/// `last_session` is the session in force when the vault last settled, and
/// `last_boundary_ts` is when that happened. Both are stored, never derived.
pub fn decide(last_session: Session, last_boundary_ts: i64, now: i64) -> Decision {
    if now < last_boundary_ts {
        // the clock went backwards; refuse rather than compute a negative span
        return Decision::Inconsistent;
    }

    let missed = boundaries_between(last_boundary_ts, now, BOUNDARY_SCAN_CAP);
    let here = session_at(now);

    // Parity is a free cross-check: an odd number of boundaries must have
    // flipped the session, an even number must have left it alone. If that does
    // not hold, the stored session disagrees with the calendar and no settlement
    // based on either can be trusted.
    let flipped = here != last_session;
    if (missed % 2 == 1) != flipped && missed < BOUNDARY_SCAN_CAP {
        return Decision::Inconsistent;
    }

    match missed {
        0 => Decision::UpToDate,
        1 => Decision::Settle { to: here },
        n => Decision::Stale { missed: n },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::{days_from_civil, SEC_PER_DAY};

    // 2026-09-21 is a Monday, EDT, so ET = UTC-4.
    fn mon(h: i64, m: i64) -> i64 {
        days_from_civil(2026, 9, 21) * SEC_PER_DAY + (h + 4) * 3600 + m * 60
    }
    fn fri(h: i64, m: i64) -> i64 {
        days_from_civil(2026, 9, 18) * SEC_PER_DAY + (h + 4) * 3600 + m * 60
    }

    #[test]
    fn nothing_to_do_inside_a_session() {
        let d = decide(Session::Open, mon(10, 0), mon(12, 0));
        assert_eq!(d, Decision::UpToDate);
    }

    #[test]
    fn one_boundary_settles() {
        // settled at the open; now just after the close
        let d = decide(Session::Open, mon(9, 30), mon(16, 1));
        assert_eq!(d, Decision::Settle { to: Session::Closed });
    }

    /// The bug this module exists to make impossible.
    #[test]
    fn a_missed_weekend_halts_instead_of_paying_the_wrong_class() {
        // Vault last settled at Friday's open, so DAY holds the stock.
        // The crank then misses Friday's close AND Monday's open.
        let d = decide(Session::Open, fri(9, 30), mon(12, 0));

        // The old code compared class_for(session_at(now)) against exposed,
        // found Day == Day, and did nothing — handing DAY the entire weekend.
        assert_eq!(
            d,
            Decision::Stale { missed: 2 },
            "two elapsed boundaries must halt, never settle"
        );

        // and it must not be mistaken for a quiet period
        assert_ne!(d, Decision::UpToDate);
    }

    #[test]
    fn a_missed_overnight_halts() {
        // settled at Monday's close, crank wakes after Tuesday's close
        let tue_close = mon(16, 0) + SEC_PER_DAY + 60;
        let d = decide(Session::Closed, mon(16, 0), tue_close);
        assert_eq!(d, Decision::Stale { missed: 2 });
    }

    #[test]
    fn a_long_outage_reports_a_capped_count_rather_than_spinning() {
        let d = decide(Session::Open, mon(9, 30), mon(9, 30) + 400 * SEC_PER_DAY);
        match d {
            Decision::Stale { missed } => assert_eq!(missed, BOUNDARY_SCAN_CAP),
            other => panic!("expected Stale, got {other:?}"),
        }
    }

    #[test]
    fn a_stored_session_that_contradicts_the_calendar_is_rejected() {
        // claims the market was closed at Monday 10:00 ET, which is a session
        assert_eq!(
            decide(Session::Closed, mon(10, 0), mon(12, 0)),
            Decision::Inconsistent
        );
    }

    #[test]
    fn a_backwards_clock_is_rejected() {
        assert_eq!(
            decide(Session::Open, mon(12, 0), mon(10, 0)),
            Decision::Inconsistent
        );
    }

    #[test]
    fn settling_exactly_on_the_boundary_instant_is_a_boundary() {
        // 16:00:00 ET is the first instant of NIGHT, not the last of DAY
        let d = decide(Session::Open, mon(9, 30), mon(16, 0));
        assert_eq!(d, Decision::Settle { to: Session::Closed });
    }

    #[test]
    fn one_second_before_the_close_is_still_the_same_session() {
        let d = decide(Session::Open, mon(9, 30), mon(15, 59) + 59);
        assert_eq!(d, Decision::UpToDate);
    }

    /// Walking a full year one boundary at a time must never produce anything
    /// but a single clean settlement.
    #[test]
    fn a_punctual_crank_never_halts_across_a_whole_year() {
        use crate::calendar::next_boundary;
        let mut t = days_from_civil(2026, 1, 2) * SEC_PER_DAY + 15 * 3600;
        let mut session = session_at(t);
        let mut settled = 0;

        for _ in 0..500 {
            let Some(b) = next_boundary(t, 12) else { break };
            // a crank that fires one second late, every time
            let now = b + 1;
            match decide(session, t, now) {
                Decision::Settle { to } => {
                    assert_eq!(to, session_at(now));
                    session = to;
                    t = now;
                    settled += 1;
                }
                other => panic!("punctual crank produced {other:?} at {now}"),
            }
        }
        assert!(settled > 400, "expected a full year of boundaries, got {settled}");
    }
}
