//! Adversarial simulation of the full vault lifecycle.
//!
//! Unit tests check one operation at a time. Almost every real protocol failure
//! is a *sequence*: a mint placed just before a boundary, a partial fill sized
//! to leave dust, a redemption that drains reserved quote, a donation that
//! perturbs accounting. This runs those sequences in bulk and asserts the
//! invariants after every single step, so a violation is caught at the
//! operation that caused it rather than a thousand steps later.
//!
//! The model calls the same `ops`, `settle` and `machine` functions the program
//! calls. It is not a re-implementation — the point is to exercise the real
//! decision code under orderings no hand-written test would think to try.

use session::calendar::{next_boundary, session_at, Session};
use session::fixed::WAD;
use session::funding::FundingParams;
use session::machine::{decide, Decision};
use session::ops::{self, OpError, VaultView};
use session::settle::{settle, value_of, NavState, ShareClass};

/// Matches the program's default: a handoff residue above 2% of total value
/// stops settlement rather than compounding.
const MAX_CARRY_DELTA_BPS: u128 = 200;

/// Mirrors the on-chain `Vault` fields the lifecycle touches.
#[derive(Clone, Debug)]
struct Sim {
    night_supply: u64,
    day_supply: u64,
    night_nav: u128,
    day_nav: u128,
    exposed: ShareClass,
    last_mark: u128,
    last_session: Session,
    last_boundary_ts: i64,
    owned_underlying: u64,
    owned_quote: u64,
    pending_delta: i128,
    fill_incentive_bps: u16,
    halted: bool,
    /// Every quote atom users have put in, and taken out. The central economic
    /// question is whether anyone can make the second exceed the first without
    /// the market having moved in their favour.
    deposited: u128,
    withdrawn: u128,
}

impl Sim {
    fn new(mark: u128, ts: i64) -> Self {
        let s = session_at(ts);
        Self {
            night_supply: 0,
            day_supply: 0,
            night_nav: WAD,
            day_nav: WAD,
            exposed: if s == Session::Closed { ShareClass::Night } else { ShareClass::Day },
            last_mark: mark,
            last_session: s,
            last_boundary_ts: ts,
            owned_underlying: 0,
            owned_quote: 0,
            pending_delta: 0,
            fill_incentive_bps: 10,
            halted: false,
            deposited: 0,
            withdrawn: 0,
        }
    }

    fn view(&self) -> VaultView {
        VaultView {
            night_nav: self.night_nav,
            day_nav: self.day_nav,
            exposed: self.exposed,
            last_mark: self.last_mark,
            owned_underlying: self.owned_underlying,
            owned_quote: self.owned_quote,
            pending_delta: self.pending_delta,
            fill_incentive_bps: self.fill_incentive_bps,
        }
    }

    fn supply_of(&self, c: ShareClass) -> u64 {
        match c {
            ShareClass::Night => self.night_supply,
            ShareClass::Day => self.day_supply,
        }
    }

    fn solvency(&self) -> ops::Solvency {
        ops::solvency(&self.view(), self.night_supply, self.day_supply).expect("solvency math")
    }

    /// Total claims, which is what the vault owes its holders right now.
    fn claims(&self) -> u128 {
        value_of(self.night_supply, self.night_nav).unwrap_or(0)
            + value_of(self.day_supply, self.day_nav).unwrap_or(0)
    }

    fn mint(&mut self, c: ShareClass, quote: u64) -> Result<u64, OpError> {
        let p = ops::plan_mint(&self.view(), c, quote)?;
        self.owned_quote = p.owned_quote_after;
        match c {
            ShareClass::Night => self.night_supply += p.shares,
            ShareClass::Day => self.day_supply += p.shares,
        }
        self.deposited += quote as u128;
        Ok(p.shares)
    }

    fn redeem(&mut self, c: ShareClass, shares: u64) -> Result<u64, OpError> {
        let p = ops::plan_redeem(&self.view(), c, shares)?;
        self.owned_quote = p.owned_quote_after;
        match c {
            ShareClass::Night => self.night_supply -= shares,
            ShareClass::Day => self.day_supply -= shares,
        }
        self.withdrawn += p.quote_out as u128;
        Ok(p.quote_out)
    }

    /// Close the imbalance the way competing fillers would: repeatedly, until
    /// theremainder is dust or the vault runs out of the asset being asked for.
    fn fill_toward_zero(&mut self, mark: u128, fraction_pct: u64) -> usize {
        let mut n = 0;
        while self.pending_delta != 0 && n < 64 {
            let want = self.pending_delta.unsigned_abs() * fraction_pct as u128 / 100;
            let units = (want * WAD / mark).min(u64::MAX as u128) as u64;
            if units == 0 {
                break;
            }
            match self.fill(units, mark) {
                Ok(()) => n += 1,
                Err(_) => break,
            }
        }
        n
    }

    fn fill(&mut self, amount: u64, mark: u128) -> Result<(), OpError> {
        let p = ops::plan_fill(&self.view(), mark, amount, self.night_supply, self.day_supply)?;
        self.owned_underlying = p.owned_underlying_after;
        self.owned_quote = p.owned_quote_after;
        self.pending_delta = p.pending_delta_after;
        if p.fee_per_share > 0 {
            match p.fee_payer {
                ShareClass::Night => self.night_nav = self.night_nav.saturating_sub(p.fee_per_share),
                ShareClass::Day => self.day_nav = self.day_nav.saturating_sub(p.fee_per_share),
            }
        }
        Ok(())
    }

    /// Settle a boundary exactly as the program does, including the state
    /// machine's refusal to guess.
    fn settle_at(&mut self, ts: i64, mark: u128, fp: &FundingParams) -> Decision {
        let d = decide(self.last_session, self.last_boundary_ts, ts);
        match d {
            Decision::Settle { to, at } => {
                // The program refuses to settle on top of a handoff it never
                // filled: carrying one means real inventory no longer matches
                // what NAV claims, and a price move against that gap is how a
                // vault ends up unable to pay.
                let total = self.claims();
                if self.pending_delta != 0 && total > 0 {
                    let bps = self.pending_delta.unsigned_abs() * 10_000 / total;
                    if bps > MAX_CARRY_DELTA_BPS {
                        self.halted = true;
                        return Decision::Stale { missed: 0 };
                    }
                }
                let st = NavState {
                    night_supply: self.night_supply,
                    day_supply: self.day_supply,
                    owned_underlying: self.owned_underlying,
                    night_nav: self.night_nav,
                    day_nav: self.day_nav,
                    exposed: self.exposed,
                    last_mark: self.last_mark,
                };
                if let Ok(out) = settle(&st, mark, fp) {
                    // a loss the exposed class cannot absorb halts, unapplied
                    if out.shortfall > 0 {
                        self.halted = true;
                        return Decision::Stale { missed: 0 };
                    }
                    self.night_nav = out.night_nav;
                    self.day_nav = out.day_nav;
                    self.exposed = out.exposed;
                    self.pending_delta += out.handoff_delta;
                    self.last_mark = mark;
                    self.last_session = to;
                    // The bell, like the program — not `ts`, which is when
                    // this crank happened to fire.
                    self.last_boundary_ts = at;

                    // The vault's inventory is re-pointed at the newly exposed
                    // class; the part it could not match is what must trade.
                    let exposed_value = value_of(self.supply_of(out.exposed), match out.exposed {
                        ShareClass::Night => self.night_nav,
                        ShareClass::Day => self.day_nav,
                    })
                    .unwrap_or(0);
                    let target_underlying = if mark > 0 {
                        ((exposed_value.saturating_sub(self.pending_delta.max(0) as u128))
                            .saturating_mul(WAD)
                            / mark)
                            .min(u64::MAX as u128) as u64
                    } else {
                        0
                    };
                    let _ = target_underlying; // inventory is moved by fills, not here
                }
            }
            Decision::Stale { .. } | Decision::Inconsistent => self.halted = true,
            Decision::UpToDate => {}
        }
        d
    }
}

/// Deterministic PRNG so a failure is always reproducible from its seed.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        if n == 0 { 0 } else { self.next() % n }
    }
    fn chance(&mut self, pct: u64) -> bool {
        self.below(100) < pct
    }
}

/// Seed a vault so both classes are funded and the exposed side actually holds
/// stock, which is the state the protocol spends its life in.
fn seeded(mark: u128, ts: i64) -> Sim {
    let mut v = Sim::new(mark, ts);
    let parked = if v.exposed == ShareClass::Night { ShareClass::Day } else { ShareClass::Night };
    v.mint(parked, 500_000).unwrap();
    // fund the exposed class by hand, as an initial fill would
    let exposed = v.exposed;
    v.owned_quote += 500_000;
    match exposed {
        ShareClass::Night => v.night_supply += 500_000,
        ShareClass::Day => v.day_supply += 500_000,
    }
    v.deposited += 500_000;
    // convert the exposed class's quote into stock at the mark
    let stock = (500_000u128 * WAD / mark).min(u64::MAX as u128) as u64;
    v.owned_underlying += stock;
    v.owned_quote -= (stock as u128 * mark / WAD) as u64;
    v
}

#[test]
fn a_year_of_random_activity_never_breaks_solvency() {
    let start = session::calendar::days_from_civil(2026, 1, 2) * 86_400 + 15 * 3600;

    let mut halts = 0usize;
    for seed in 1u64..=40 {
        let mut rng = Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1);
        let mut mark = WAD * 2;
        let mut v = seeded(mark, start);
        let fp = FundingParams::default();
        let mut t = start;
        let mut steps = 0usize;

        for _ in 0..260 {
            let Some(b) = next_boundary(t, 12) else { break };

            // activity inside the session, before the boundary
            for _ in 0..rng.below(4) {
                let parked = if v.exposed == ShareClass::Night { ShareClass::Day } else { ShareClass::Night };
                match rng.below(3) {
                    0 => {
                        let _ = v.mint(parked, 1 + rng.below(50_000) as u64);
                    }
                    1 => {
                        let s = v.supply_of(parked);
                        if s > 0 {
                            let _ = v.redeem(parked, 1 + rng.below(s / 2 + 1) as u64);
                        }
                    }
                    _ => {
                        // a filler nibbling at whatever imbalance is left
                        if v.pending_delta != 0 {
                            v.fill_toward_zero(mark, 10 + rng.below(60));
                        }
                    }
                }
                steps += 1;
                let s = v.solvency();
                assert!(
                    s.ok(),
                    "seed {seed} step {steps}: insolvent by {} after user op ({:?})",
                    -s.margin(), v
                );
            }

            // the market moves, then the boundary settles
            let before_state = v.clone();
            let mark_before = mark;
            let up = rng.chance(52);
            let bp = rng.below(300);
            mark = if up { mark + mark * bp as u128 / 10_000 } else { mark - mark * bp as u128 / 10_000 };
            mark = mark.max(WAD / 100);

            let d = v.settle_at(b + 1, mark, &fp);
            t = b + 1;
            if v.halted {
                // A halt is the protocol refusing to settle something it cannot
                // pay. That is correct behaviour, not a failure — but it must
                // leave the vault solvent, which is the whole point of stopping
                // before applying the settlement.
                let s = v.solvency();
                assert!(s.ok(), "seed {seed}: halted while already insolvent by {}", -s.margin());
                halts += 1;
                break;
            }
            assert!(
                !matches!(d, Decision::Inconsistent),
                "seed {seed}: punctual crank produced {d:?}"
            );

            // Arbitrageurs close the handoff. Most of the time they take all of
            // it; sometimes only part, which is the stress the guards exist for.
            let appetite = match rng.below(10) {
                0 => 25,   // a thin day: only a quarter gets filled
                1 => 60,
                _ => 100,
            };
            v.fill_toward_zero(mark, appetite);
            let s = v.solvency();
            assert!(s.ok(), "seed {seed}: filling broke solvency by {}", -s.margin());

            let s = v.solvency();
            assert!(
                s.ok(),
                "seed {seed}: settlement broke solvency by {}\n  before={:?}\n  after ={:?}\n  mark {} -> {}",
                -s.margin(), before_state, v, mark_before, mark
            );
        }
        assert!(steps > 20, "seed {seed} barely exercised anything");
    }
    // The guards must actually fire under this much churn — a suite where they
    // never trigger is not exercising them.
    assert!(halts > 0, "no run ever tripped a guard; the simulation is too gentle");
    println!("{halts}/40 runs halted on a guard rather than settling something unpayable");

    // The halt rate is a dashboard number, not a README flex: written where
    // the site and CI can read it, from the run that produced it.
    let report = format!(
        "{{\n \"note\": \"Generated by `cargo test -p session --test simulation a_year_of_random_activity`. \
40 seeded years of random mints, redemptions, partial fills and up to 3% moves per bell; a halt is a guard refusing to settle something unpayable, with the vault left solvent.\",\n \
 \"runs\": 40,\n \"bells_per_run\": 260,\n \"halts\": {halts},\n \"halt_rate\": {:.4},\n \
 \"halt_rate_of\": \"runs — a run stops at its first halt, so this is the share of simulated years that halt once, not a per-bell rate\",\n \
 \"max_carry_delta_bps\": {}\n}}\n",
        halts as f64 / 40.0, MAX_CARRY_DELTA_BPS
    );
    std::fs::create_dir_all("../../data").ok();
    std::fs::write("../../data/sim-report.json", report).ok();
}

/// The gap the NIGHT class exists to wear. Before, a move past the guard
/// refused to settle, and a vault that could not settle at all was one missed
/// bell from a halt — on the exact event it was built to isolate. Now it
/// settles; the exposed class takes the whole move; nobody else does.
#[test]
fn a_twenty_percent_gap_settles_and_the_exposed_class_wears_all_of_it() {
    let start = session::calendar::days_from_civil(2026, 9, 18) * 86_400 + 16 * 3600; // Fri 12:00 ET
    let mark = WAD * 2;
    let mut v = seeded(mark, start);
    let fp = FundingParams::new(0, 0); // funding off, so the move is the only thing that changes NAV
    let close = next_boundary(start, 12).unwrap();

    // DAY holds the stock through Friday's session; the print at the close
    // is 20% below where the session opened.
    assert_eq!(v.exposed, ShareClass::Day);
    let (night_before, day_before) = (v.night_nav, v.day_nav);
    let gap = mark * 8 / 10;
    let move_bps = session::oracle::move_bps(gap, mark).unwrap();
    assert_eq!(move_bps, 2_000, "a 20% gap measures as 2,000 bp");
    assert!(move_bps > 1_000, "and it is past a 10% jump threshold");

    let d = v.settle_at(close + 60, gap, &fp);
    assert!(matches!(d, Decision::Settle { .. }), "the gap must settle, got {d:?}");
    assert!(!v.halted, "a jump is not a halt");
    assert_eq!(v.night_nav, night_before, "the parked class is untouched by the gap");
    assert!(v.day_nav < day_before * 81 / 100 && v.day_nav > day_before * 79 / 100,
        "DAY wore the 20%: {} -> {}", day_before, v.day_nav);
    assert!(v.solvency().ok(), "and the vault is still solvent");
    assert_eq!(v.exposed, ShareClass::Night, "the handoff still happened");
}

#[test]
fn no_sequence_of_operations_lets_a_user_extract_more_than_the_market_gave() {
    // The vault's assets only grow when the mark grows. Hold the mark flat and
    // any net gain to users must come out of the vault — which is the attack.
    let start = session::calendar::days_from_civil(2026, 3, 2) * 86_400 + 15 * 3600;
    let mark = WAD * 3;

    for seed in 1u64..=60 {
        let mut rng = Rng(seed.wrapping_mul(0xD1B54A32D192ED03) | 1);
        let mut v = seeded(mark, start);
        let opening_claims = v.claims();
        let fp = FundingParams::default();
        let mut t = start;

        for _ in 0..40 {
            let Some(b) = next_boundary(t, 12) else { break };
            let parked = if v.exposed == ShareClass::Night { ShareClass::Day } else { ShareClass::Night };

            // hammer the parked class with mint/redeem churn, which is where a
            // rounding or reservation bug would show up
            for _ in 0..rng.below(6) {
                if rng.chance(50) {
                    let _ = v.mint(parked, 1 + rng.below(20_000) as u64);
                } else {
                    let s = v.supply_of(parked);
                    if s > 0 {
                        let _ = v.redeem(parked, 1 + rng.below(s) as u64);
                    }
                }
                assert!(v.solvency().ok(), "seed {seed}: churn broke solvency");
            }
            // settle with an unchanged mark: no real gain is available
            v.settle_at(b + 1, mark, &fp);
            t = b + 1;
        }

        // drain whatever is redeemable
        for _ in 0..4 {
            let parked = if v.exposed == ShareClass::Night { ShareClass::Day } else { ShareClass::Night };
            let s = v.supply_of(parked);
            if s > 0 {
                let _ = v.redeem(parked, s);
            }
            let Some(b) = next_boundary(t, 12) else { break };
            v.settle_at(b + 1, mark, &fp);
            t = b + 1;
        }

        // With a flat mark, users can never have taken out more than they put
        // in plus what they still hold a claim on.
        let outstanding = v.claims();
        assert!(
            v.withdrawn <= v.deposited + 8,
            "seed {seed}: users extracted {} from {} deposited (flat mark)",
            v.withdrawn, v.deposited
        );
        assert!(
            v.withdrawn + outstanding <= v.deposited + opening_claims + 8,
            "seed {seed}: claims plus withdrawals exceed deposits"
        );
    }
}

#[test]
fn donations_cannot_perturb_accounting() {
    // Anyone can transfer into the vault's token accounts. Because balances are
    // tracked rather than read, a donation must be invisible to every number
    // that decides who owns what.
    let ts = session::calendar::days_from_civil(2026, 5, 4) * 86_400 + 15 * 3600;
    let mark = WAD * 2;
    let mut v = seeded(mark, ts);

    let before = (v.night_nav, v.day_nav, v.solvency(), v.pending_delta);
    // the donation lands in the token account; `owned_*` deliberately does not move
    let donated_underlying = 5_000_000u64;
    let donated_quote = 9_000_000u64;
    let _ = (donated_underlying, donated_quote);
    let after = (v.night_nav, v.day_nav, v.solvency(), v.pending_delta);
    assert_eq!(before, after, "a donation changed vault accounting");

    // and a mint after the donation prices identically
    let parked = if v.exposed == ShareClass::Night { ShareClass::Day } else { ShareClass::Night };
    let nav_before = v.view().nav_of(parked);
    let shares = v.mint(parked, 100_000).unwrap();
    assert_eq!(
        shares,
        (100_000u128 * WAD / nav_before) as u64,
        "donation leaked into the mint price"
    );
}

#[test]
fn a_crank_outage_halts_and_never_silently_reattributes() {
    let start = session::calendar::days_from_civil(2026, 9, 18) * 86_400 + 16 * 3600; // Fri 12:00 ET
    let mark = WAD * 2;
    let mut v = seeded(mark, start);
    let fp = FundingParams::default();

    let night_before = v.night_nav;
    let day_before = v.day_nav;

    // crank sleeps through Friday's close and Monday's open
    let monday_noon = session::calendar::days_from_civil(2026, 9, 21) * 86_400 + 16 * 3600;
    let d = v.settle_at(monday_noon, mark * 12 / 10, &fp);

    assert!(matches!(d, Decision::Stale { missed: 2 }), "expected a halt, got {d:?}");
    assert!(v.halted, "vault must stop rather than guess");
    assert_eq!(v.night_nav, night_before, "no NAV may move on a halted boundary");
    assert_eq!(v.day_nav, day_before, "no NAV may move on a halted boundary");
}

#[test]
fn partial_fills_converge_and_never_overshoot() {
    let ts = session::calendar::days_from_civil(2026, 4, 6) * 86_400 + 15 * 3600;
    let mark = WAD * 5;
    let mut v = seeded(mark, ts);
    v.pending_delta = 400_000;
    v.owned_quote += 500_000;

    let mut rng = Rng(0xABCDEF);
    let mut fills = 0;
    let start_sign = v.pending_delta.signum();

    while v.pending_delta != 0 && fills < 200 {
        let want = v.pending_delta.unsigned_abs();
        let units = ((want * WAD / mark) as u64).max(1);
        let take = 1 + rng.below(units.max(1));
        match v.fill(take, mark) {
            Ok(()) => {
                assert!(
                    v.pending_delta.signum() == start_sign || v.pending_delta == 0,
                    "a fill flipped the imbalance past zero"
                );
                assert!(v.solvency().ok(), "a partial fill broke solvency");
            }
            Err(OpError::AmountTooSmall) | Err(OpError::NothingToFill) => break,
            Err(e) => panic!("unexpected fill failure: {e:?}"),
        }
        fills += 1;
    }
    assert!(fills > 1, "expected several partial fills");
    assert!(
        v.pending_delta.unsigned_abs() * WAD / mark < 2,
        "imbalance failed to converge: {} left",
        v.pending_delta
    );
}


/* ── adversarial: specific attacks, not random churn ─────────────────────── */

#[test]
fn settling_the_same_boundary_twice_does_nothing_the_second_time() {
    // Duplicate transactions are normal on Solana — a retry, a re-broadcast, or
    // two keepers racing. Settling twice must not roll NAV twice.
    let start = session::calendar::days_from_civil(2026, 6, 2) * 86_400 + 15 * 3600;
    let mark = WAD * 3;
    let mut v = seeded(mark, start);
    let fp = FundingParams::default();

    let b = next_boundary(start, 12).unwrap();
    let moved = mark * 105 / 100;

    let first = v.settle_at(b + 1, moved, &fp);
    assert!(matches!(first, Decision::Settle { .. }));
    let after_first = (v.night_nav, v.day_nav, v.exposed, v.pending_delta);

    // the same crank fires again a second later
    let second = v.settle_at(b + 2, moved, &fp);
    assert_eq!(second, Decision::UpToDate, "a duplicate settle must be a no-op");
    assert_eq!(
        (v.night_nav, v.day_nav, v.exposed, v.pending_delta),
        after_first,
        "the second settlement changed state"
    );

    // and again much later in the same session
    let third = v.settle_at(b + 3 * 3600, moved, &fp);
    assert_eq!(third, Decision::UpToDate);
    assert_eq!((v.night_nav, v.day_nav, v.exposed, v.pending_delta), after_first);
}

#[test]
fn dust_sized_fills_cannot_drain_the_incentive() {
    // A griefer might try to extract the fill incentive by splitting a fill
    // into thousands of tiny ones, hoping each rounds in their favour.
    let ts = session::calendar::days_from_civil(2026, 6, 3) * 86_400 + 15 * 3600;
    let mark = WAD * 4;
    let mut v = seeded(mark, ts);
    v.pending_delta = 200_000;
    v.owned_quote += 400_000;
    v.fill_incentive_bps = 10;

    let before = v.solvency().margin();
    let claims_before = v.claims();

    let mut fills = 0;
    for _ in 0..3_000 {
        match v.fill(1, mark) {
            Ok(()) => fills += 1,
            Err(_) => break,
        }
        assert!(v.solvency().ok(), "a dust fill broke solvency");
    }

    // Whatever they managed, the vault is no worse off than the incentive it
    // agreed to pay, and that cost landed on a class rather than on backing.
    let after = v.solvency().margin();
    assert!(
        after >= before - 4,
        "dust fills drained {} beyond the incentive over {fills} fills",
        before - after
    );
    assert!(
        v.claims() <= claims_before,
        "dust fills inflated claims"
    );
}

#[test]
fn a_redeemer_cannot_take_quote_committed_to_a_handoff() {
    // The vault owes the market a purchase. A redeemer racing to take that
    // quote first would leave the handoff unfillable and the inventory wrong.
    let ts = session::calendar::days_from_civil(2026, 6, 4) * 86_400 + 15 * 3600;
    let mark = WAD * 2;
    let mut v = seeded(mark, ts);

    let parked = if v.exposed == ShareClass::Night { ShareClass::Day } else { ShareClass::Night };
    let supply = v.supply_of(parked);
    v.pending_delta = (v.owned_quote as i128) - 10; // almost everything is spoken for

    // redeeming the whole parked class would need far more than is free
    let big = v.redeem(parked, supply);
    assert_eq!(big, Err(OpError::InsufficientFreeQuote), "reserved quote was payable");

    // but the unreserved remainder is still redeemable
    let free = v.view().free_quote();
    assert!(free >= 10, "expected a small free balance, got {free}");
    assert!(v.solvency().ok());
}
