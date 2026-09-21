//! The session for a name with no exchange behind it.
//!
//! A pre-IPO token has no 09:30 and no closing bell. Putting one on a NYSE
//! clock would be a lie with a countdown on it: OPENAI does not open, and the
//! hours it "trades" are all of them. What it has instead is *prints* — a
//! tender, a round, a 409A — and between them a price that is somebody's mark
//! rather than a market's.
//!
//! So the same two mints split a different axis:
//!
//! | class  | holds                                                        |
//! |--------|--------------------------------------------------------------|
//! | `NOW`  | the token as it trades between prints, always exitable       |
//! | `THEN` | the print itself, and the divergence that precedes it        |
//!
//! Two things put THEN on risk. A **scheduled print**: the window around a
//! known event, which the operator posts in advance and the program treats
//! like a bell. And a **premium divergence**: when what the token executes at
//! pulls away from the issuer's mark by more than the vault tolerates, the
//! gap between the fiction and the market is exactly what THEN exists to
//! wear, and it takes over until the two converge.
//!
//! The second is not schedulable, which is the honest difference from an
//! equity session. There the calendar is public and a crank can be checked
//! against it; here the detector is posted by an operator and the program can
//! only bound its staleness. That asymmetry is stated on the vault page
//! rather than smoothed over.

use crate::calendar::Session;
use crate::machine::Decision;

/// The most prints a vault tracks at once.
pub const MAX_EVENTS: usize = 8;

/// A scheduled print, and how long after it THEN keeps the risk.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Event {
    /// When the print lands. Zero means the slot is empty.
    pub ts: i64,
    /// How long after `ts` the print is still being absorbed.
    pub window_secs: u32,
    /// Free-form: 0 tender, 1 round, 2 valuation, 3 other. Carried for the
    /// UI, never acted on.
    pub kind: u8,
}

impl Event {
    pub fn is_set(&self) -> bool {
        self.ts > 0
    }
    pub fn end(&self) -> i64 {
        self.ts.saturating_add(self.window_secs as i64)
    }
    pub fn contains(&self, t: i64) -> bool {
        self.is_set() && t >= self.ts && t < self.end()
    }
}

/// The last reading an operator posted: the issuer's mark, and what the token
/// actually executes at. Both in the same units; only their ratio is used.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Detector {
    pub mark: u128,
    pub executable: u128,
    pub ts: i64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EventError {
    /// The detector has not been posted recently enough to act on.
    DetectorStale,
    Overflow,
}

/// How far `executable` sits from `mark`, in basis points. Zero when either
/// side is missing — an absent reading is not a divergence.
pub fn premium_bps(d: &Detector) -> Result<u128, EventError> {
    if d.mark == 0 || d.executable == 0 {
        return Ok(0);
    }
    let diff = if d.executable > d.mark { d.executable - d.mark } else { d.mark - d.executable };
    diff.checked_mul(10_000).ok_or(EventError::Overflow).map(|x| x / d.mark)
}

/// Which class should hold the token at `now`.
///
/// `Session::Closed` means THEN is exposed, mirroring the equity vault where
/// a closed market puts NIGHT on risk. One `ShareClass` mapping serves both,
/// so nothing downstream has to know which kind of session it is.
pub fn session_for(
    events: &[Event],
    d: &Detector,
    now: i64,
    max_premium_bps: u16,
) -> Result<Session, EventError> {
    if events.iter().any(|e| e.contains(now)) {
        return Ok(Session::Closed);
    }
    if premium_bps(d)? > max_premium_bps as u128 {
        return Ok(Session::Closed);
    }
    Ok(Session::Open)
}

/// The scheduled boundary in `(from, to]`, and how many there are.
///
/// A print contributes two: the moment it lands and the moment its window
/// closes. More than one elapsed means the marks in between are gone, and the
/// vault halts exactly as the equity one does.
fn scheduled_between(events: &[Event], from: i64, to: i64) -> (Option<i64>, u32) {
    let mut count = 0u32;
    let mut first = None;
    for e in events.iter().filter(|e| e.is_set()) {
        for b in [e.ts, e.end()] {
            if b > from && b <= to {
                count += 1;
                first = Some(first.map_or(b, |f: i64| f.min(b)));
            }
        }
    }
    (first, count)
}

/// Decide what a crank at `now` should do for an event session.
///
/// `detector_max_stale_secs` bounds how old the posted reading may be. A
/// stale detector is not a reason to guess: the vault reports it and does
/// nothing, the same way a stale mark refuses a settlement.
pub fn decide_event(
    events: &[Event],
    d: &Detector,
    last_session: Session,
    last_boundary_ts: i64,
    now: i64,
    max_premium_bps: u16,
    detector_max_stale_secs: u32,
) -> Result<Decision, EventError> {
    if now < last_boundary_ts {
        return Ok(Decision::Inconsistent);
    }
    if now.saturating_sub(d.ts) > detector_max_stale_secs as i64 {
        return Err(EventError::DetectorStale);
    }

    let here = session_for(events, d, now, max_premium_bps)?;
    let (first_scheduled, scheduled) = scheduled_between(events, last_boundary_ts, now);

    // More than one scheduled boundary elapsed: the same unrecoverable gap a
    // missed bell leaves, and the same answer.
    if scheduled > 1 {
        return Ok(Decision::Stale { missed: scheduled });
    }
    if here == last_session {
        // A print landed and its window closed between two cranks: the class
        // that should have worn it never did, and no price now can say what
        // it was worth.
        if scheduled == 1 {
            return Ok(Decision::Stale { missed: 1 });
        }
        return Ok(Decision::UpToDate);
    }

    // The bell is the scheduled instant when there is one. A premium flip has
    // no schedule, so it is stamped with the reading that caused it — the
    // detector's own timestamp, never `now`, which is merely when somebody
    // got around to cranking.
    Ok(Decision::Settle { to: here, at: first_scheduled.unwrap_or(d.ts) })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: i64 = 3_600;
    const T0: i64 = 1_800_000_000;

    fn det(mark: u128, executable: u128, ts: i64) -> Detector {
        Detector { mark, executable, ts }
    }
    fn flat(ts: i64) -> Detector {
        det(1_000, 1_000, ts)
    }
    const NONE: [Event; 0] = [];

    #[test]
    fn between_prints_and_at_parity_now_holds_it() {
        let s = session_for(&NONE, &flat(T0), T0, 1_000).unwrap();
        assert_eq!(s, Session::Open, "NOW is exposed while nothing is happening");
    }

    #[test]
    fn a_print_window_puts_then_on_risk() {
        let e = [Event { ts: T0 + HOUR, window_secs: 2 * HOUR as u32, kind: 0 }];
        assert_eq!(session_for(&e, &flat(T0), T0, 1_000).unwrap(), Session::Open);
        assert_eq!(session_for(&e, &flat(T0), T0 + HOUR, 1_000).unwrap(), Session::Closed);
        assert_eq!(session_for(&e, &flat(T0), T0 + 2 * HOUR, 1_000).unwrap(), Session::Closed);
        // the window is half-open: at its end NOW has it back
        assert_eq!(session_for(&e, &flat(T0), T0 + 3 * HOUR, 1_000).unwrap(), Session::Open);
    }

    /// The real OPENAI reading on the day this was written: the issuer marks
    /// it at 995.88 and it executes at 1121.09 — a 1,257 bp premium. At a 10%
    /// tolerance THEN wears it.
    #[test]
    fn a_real_divergence_flips_it() {
        let d = det(99_588, 112_109, T0);
        assert_eq!(premium_bps(&d).unwrap(), 1_257);
        assert_eq!(session_for(&NONE, &d, T0, 1_000).unwrap(), Session::Closed);
        assert_eq!(session_for(&NONE, &d, T0, 2_000).unwrap(), Session::Open, "a wider tolerance leaves it with NOW");
    }

    #[test]
    fn a_discount_diverges_as_much_as_a_premium() {
        // SPACEX the same day: marked 153.30, executing at 119.68.
        let d = det(15_330, 11_968, T0);
        assert_eq!(premium_bps(&d).unwrap(), 2_193);
        assert_eq!(session_for(&NONE, &d, T0, 1_000).unwrap(), Session::Closed);
    }

    #[test]
    fn a_missing_reading_is_not_a_divergence() {
        assert_eq!(premium_bps(&det(0, 100, T0)).unwrap(), 0);
        assert_eq!(premium_bps(&det(100, 0, T0)).unwrap(), 0);
    }

    #[test]
    fn a_stale_detector_refuses_rather_than_guesses() {
        let d = flat(T0 - 2 * HOUR);
        let r = decide_event(&NONE, &d, Session::Open, T0 - 3 * HOUR, T0, 1_000, HOUR as u32);
        assert_eq!(r, Err(EventError::DetectorStale));
    }

    #[test]
    fn a_scheduled_print_settles_at_the_print_not_at_the_crank() {
        let e = [Event { ts: T0, window_secs: 2 * HOUR as u32, kind: 0 }];
        // cranked three hours late, inside the window
        let d = flat(T0 + HOUR + 1_800);
        let r = decide_event(&e, &d, Session::Open, T0 - HOUR, T0 + HOUR + 1_800, 1_000, 2 * HOUR as u32).unwrap();
        assert_eq!(r, Decision::Settle { to: Session::Closed, at: T0 }, "the bell is the print");
    }

    #[test]
    fn a_premium_flip_is_stamped_with_the_reading_that_caused_it() {
        let d = det(99_588, 112_109, T0 + 600);
        let r = decide_event(&NONE, &d, Session::Open, T0, T0 + 900, 1_000, HOUR as u32).unwrap();
        assert_eq!(r, Decision::Settle { to: Session::Closed, at: T0 + 600 },
            "not `now`: the crank is not the event");
    }

    #[test]
    fn nothing_to_do_when_the_state_already_matches() {
        let r = decide_event(&NONE, &flat(T0), Session::Open, T0 - HOUR, T0, 1_000, HOUR as u32).unwrap();
        assert_eq!(r, Decision::UpToDate);
    }

    #[test]
    fn a_print_slept_through_halts_rather_than_paying_the_wrong_class() {
        let e = [Event { ts: T0, window_secs: HOUR as u32, kind: 0 }];
        // cranked after the window closed: back to Open, as if nothing happened
        let d = flat(T0 + 2 * HOUR);
        let r = decide_event(&e, &d, Session::Open, T0 - HOUR, T0 + 2 * HOUR, 1_000, 2 * HOUR as u32).unwrap();
        assert_eq!(r, Decision::Stale { missed: 2 }, "both boundaries elapsed unseen");
    }

    /// A boundary elapsed but the effective session reads the same as the
    /// tracked one. That is not "nothing happened": the vault was already on
    /// THEN for a divergence when the print landed, so a session changed
    /// hands with no settlement and no price now can say what it was worth.
    #[test]
    fn a_single_elapsed_boundary_with_unchanged_state_still_halts() {
        let e = [Event { ts: T0, window_secs: HOUR as u32, kind: 0 }];
        let diverged = det(99_588, 112_109, T0 + 30);
        let r = decide_event(&e, &diverged, Session::Closed, T0 - HOUR, T0 + 30, 1_000, HOUR as u32).unwrap();
        assert_eq!(r, Decision::Stale { missed: 1 });

        // From the other side it is an ordinary flip, stamped with the print.
        let r2 = decide_event(&e, &diverged, Session::Open, T0 - HOUR, T0 + 30, 1_000, HOUR as u32).unwrap();
        assert_eq!(r2, Decision::Settle { to: Session::Closed, at: T0 });
    }

    #[test]
    fn a_clock_that_went_backwards_is_inconsistent() {
        let r = decide_event(&NONE, &flat(T0), Session::Open, T0 + HOUR, T0, 1_000, HOUR as u32).unwrap();
        assert_eq!(r, Decision::Inconsistent);
    }

    #[test]
    fn several_prints_are_tracked_at_once() {
        let e = [
            Event { ts: T0, window_secs: HOUR as u32, kind: 0 },
            Event { ts: T0 + 10 * HOUR, window_secs: HOUR as u32, kind: 1 },
            Event::default(), // an empty slot is ignored
        ];
        assert_eq!(session_for(&e, &flat(T0 + 5 * HOUR), T0 + 5 * HOUR, 1_000).unwrap(), Session::Open);
        assert_eq!(session_for(&e, &flat(T0 + 10 * HOUR), T0 + 10 * HOUR, 1_000).unwrap(), Session::Closed);
        let (first, n) = scheduled_between(&e, T0 - HOUR, T0 + 11 * HOUR);
        assert_eq!((first, n), (Some(T0), 4));
    }
}
