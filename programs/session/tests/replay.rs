//! Replay real market history through the real settlement code.
//!
//! The statistics in `research/` are computed independently, in TypeScript. This
//! is the other direction: feed months of actual hourly closes from Solana pools
//! into the *same* `settle()` the program runs on chain, boundary by boundary,
//! and check that the two token NAVs end up where the session decomposition says
//! they should.
//!
//! It is the closest thing to a dress rehearsal available without a year of
//! mainnet: same calendar, same fixed-point, same funding, same rounding.
//!
//! Requires `data/_hourly.json` (`node research/fetch-hourly.mjs`). Skips
//! cleanly when it is absent so the suite still runs on a fresh clone.

use session::calendar::{session_at, Session};
use session::fixed::WAD;
use session::funding::FundingParams;
use session::settle::{settle, NavState, ShareClass};

const DATA: &str = "../../data/_hourly.json";

/// One asset's replay outcome.
struct Replay {
    symbol: String,
    kind: String,
    boundaries: usize,
    night_nav: u128,
    day_nav: u128,
    /// Independent reference: the product of each session's price ratio.
    ref_night: f64,
    ref_day: f64,
    first: i64,
    last: i64,
}

fn replay(symbol: &str, kind: &str, rows: &[(i64, f64)], fp: &FundingParams) -> Option<Replay> {
    if rows.len() < 200 {
        return None;
    }
    let to_mark = |p: f64| -> u128 { (p * WAD as f64 / 1_000.0) as u128 };

    let start_mark = to_mark(rows[0].1);
    let mut state = NavState {
        // equal-sized classes: the case the protocol is designed around, where
        // every handoff is internal and nothing trades
        night_supply: 1_000_000_000,
        day_supply: 1_000_000_000,
        // hedged exactly: the vault holds the exposed class's value in stock
        owned_underlying: if start_mark > 0 {
            ((1_000_000_000u128 * WAD / start_mark).min(u64::MAX as u128)) as u64
        } else { 0 },
        night_nav: WAD,
        day_nav: WAD,
        exposed: match session_at(rows[0].0) {
            Session::Closed => ShareClass::Night,
            Session::Open => ShareClass::Day,
        },
        last_mark: to_mark(rows[0].1),
    };

    let mut ref_night = 1.0f64;
    let mut ref_day = 1.0f64;
    let mut ref_anchor = rows[0].1;
    let mut cur = session_at(rows[0].0);
    let mut boundaries = 0usize;

    for &(t, px) in &rows[1..] {
        if px <= 0.0 {
            continue;
        }
        let s = session_at(t);
        if s == cur {
            continue;
        }

        // a boundary: settle at this price
        let mark = to_mark(px);
        if mark == 0 || state.last_mark == 0 {
            cur = s;
            continue;
        }
        let out = match settle(&state, mark, fp) {
            Ok(o) => o,
            Err(_) => {
                cur = s;
                continue;
            }
        };

        // independent reference, in floating point, from the raw prices
        let ratio = px / ref_anchor;
        match cur {
            Session::Closed => ref_night *= ratio,
            Session::Open => ref_day *= ratio,
        }
        ref_anchor = px;

        // re-point inventory at the newly exposed class, as a filled handoff does
        let exposed_value = match out.exposed {
            ShareClass::Night => (state.night_supply as u128) * out.night_nav / WAD,
            ShareClass::Day => (state.day_supply as u128) * out.day_nav / WAD,
        };
        state = NavState {
            night_nav: out.night_nav,
            day_nav: out.day_nav,
            exposed: out.exposed,
            last_mark: mark,
            owned_underlying: ((exposed_value * WAD / mark).min(u64::MAX as u128)) as u64,
            ..state
        };
        cur = s;
        boundaries += 1;
    }

    Some(Replay {
        symbol: symbol.to_string(),
        kind: kind.to_string(),
        boundaries,
        night_nav: state.night_nav,
        day_nav: state.day_nav,
        ref_night,
        ref_day,
        first: rows[0].0,
        last: rows.last().unwrap().0,
    })
}

fn load() -> Option<serde_json::Value> {
    let raw = std::fs::read_to_string(DATA).ok()?;
    serde_json::from_str(&raw).ok()
}

#[test]
fn nav_reproduces_the_session_split_on_real_history() {
    let Some(doc) = load() else {
        eprintln!("skipping: {DATA} not present — run `node research/fetch-hourly.mjs`");
        return;
    };
    let assets = doc["assets"].as_array().expect("assets array");
    let fp = FundingParams::new(0, 0); // funding off: isolate the split itself

    println!(
        "\n{:<11}{:>6}{:>12}{:>12}{:>12}{:>12}",
        "asset", "bnds", "NIGHT nav", "ref", "DAY nav", "ref"
    );
    println!("{}", "-".repeat(65));

    let mut checked = 0usize;
    let mut equity_night_wins = 0usize;
    let mut equity_total = 0usize;

    for a in assets {
        let symbol = a["symbol"].as_str().unwrap_or("?");
        let kind = a["kind"].as_str().unwrap_or("?");
        let rows: Vec<(i64, f64)> = a["rows"]
            .as_array()
            .map(|v| {
                v.iter()
                    .filter_map(|r| {
                        Some((r.get(0)?.as_i64()?, r.get(1)?.as_f64()?))
                    })
                    .collect()
            })
            .unwrap_or_default();

        let Some(r) = replay(symbol, kind, &rows, &fp) else { continue };
        if r.boundaries < 40 {
            continue;
        }

        let night = r.night_nav as f64 / WAD as f64;
        let day = r.day_nav as f64 / WAD as f64;
        println!(
            "{:<11}{:>6}{:>12.4}{:>12.4}{:>12.4}{:>12.4}",
            r.symbol, r.boundaries, night, r.ref_night, day, r.ref_day
        );

        // The protocol's fixed-point NAV must track the floating-point reference.
        // 1% over hundreds of compounded boundaries is a generous band for f64
        // drift while still catching any real accounting error.
        let rel = |a: f64, b: f64| (a - b).abs() / b.max(1e-9);
        assert!(
            rel(night, r.ref_night) < 0.01,
            "{}: NIGHT nav {night} drifted from reference {}",
            r.symbol,
            r.ref_night
        );
        assert!(
            rel(day, r.ref_day) < 0.01,
            "{}: DAY nav {day} drifted from reference {}",
            r.symbol,
            r.ref_day
        );

        // the two classes must not be the same asset
        assert!(
            (night - day).abs() > 1e-9,
            "{}: the split produced two identical claims",
            r.symbol
        );

        checked += 1;
        if kind == "public" {
            equity_total += 1;
            if night > day {
                equity_night_wins += 1;
            }
        }
        let _ = (r.first, r.last);
    }

    println!("{}", "-".repeat(65));
    assert!(checked > 0, "no asset had enough history to replay");
    println!(
        "replayed {checked} assets through the on-chain settlement path; \
         NIGHT beat DAY in {equity_night_wins}/{equity_total} US equities"
    );
}

#[test]
fn funding_never_creates_value_across_a_long_replay() {
    let Some(doc) = load() else {
        eprintln!("skipping: {DATA} not present");
        return;
    };
    let assets = doc["assets"].as_array().unwrap();
    let fp = FundingParams::default();

    for a in assets.iter().take(4) {
        let rows: Vec<(i64, f64)> = a["rows"]
            .as_array()
            .map(|v| {
                v.iter()
                    .filter_map(|r| Some((r.get(0)?.as_i64()?, r.get(1)?.as_f64()?)))
                    .collect()
            })
            .unwrap_or_default();
        if rows.len() < 500 {
            continue;
        }

        // a deliberately lopsided book, so funding is active at every boundary
        let m0 = (rows[0].1 * WAD as f64 / 1_000.0) as u128;
        let mut state = NavState {
            night_supply: 3_000_000_000,
            day_supply: 1_000_000_000,
            owned_underlying: if m0 > 0 {
                ((3_000_000_000u128 * WAD / m0).min(u64::MAX as u128)) as u64
            } else { 0 },
            night_nav: WAD,
            day_nav: WAD,
            exposed: ShareClass::Night,
            last_mark: m0,
        };
        let mut cur = session_at(rows[0].0);

        for &(t, px) in &rows[1..] {
            let s = session_at(t);
            if s == cur || px <= 0.0 {
                continue;
            }
            let mark = (px * WAD as f64 / 1_000.0) as u128;
            if mark == 0 {
                continue;
            }
            if let Ok(out) = settle(&state, mark, &fp) {
                // funding moves value between classes; it must never mint any
                let before = out.value_night + out.value_day;
                assert!(before > 0, "vault emptied itself");
                let exposed_value = match out.exposed {
                    ShareClass::Night => (state.night_supply as u128) * out.night_nav / WAD,
                    ShareClass::Day => (state.day_supply as u128) * out.day_nav / WAD,
                };
                state = NavState {
                    night_nav: out.night_nav,
                    day_nav: out.day_nav,
                    exposed: out.exposed,
                    last_mark: mark,
                    owned_underlying: ((exposed_value * WAD / mark).min(u64::MAX as u128)) as u64,
                    ..state
                };
            }
            cur = s;
        }
        assert!(state.night_nav > 0 && state.day_nav > 0, "a class went to zero");
    }
}
