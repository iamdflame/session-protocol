//! Randomised crosses through the program itself.
//!
//! One cross per trading day, each with a random share price, 1-5 buyers and
//! 1-5 sellers with random sizes and random limits (some out of band), and
//! 0-3 makers with random sizes and fees on whichever side comes out
//! crowded. Every cross runs the whole lifecycle on the real NVDAx mint:
//! place, a Pyth-verified print, price, confirm, auction, clear, settle and
//! close.
//!
//! Every participant's balance change must equal `session_core::cross`
//! computed from the same book, to the atom, and the escrow must be empty
//! after every close. Seeded, so a failure reproduces. CROSS_FUZZ sets how
//! many crosses (default 40); CROSS_FUZZ_SEED changes the seed.

use bell_integration::cross::*;
use bell_integration::*;
use session_core::calendar::day_session_bounds;
use session_core::cross as math;
use session_core::xstock;
use solana_keypair::Keypair;
use solana_signer::Signer;

const M_WAD: u128 = 1_001_701_196_801_074_056;

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 11
    }
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next() % (hi - lo)
    }
    fn chance(&mut self, pct: u64) -> bool {
        self.next() % 100 < pct
    }
}

struct Party {
    key: Keypair,
    side: u8,
    amount: u64,
    limit_e8: u64,
    raw0: u64,
    quote0: u64,
}

#[test]
fn randomised_crosses_match_the_arithmetic_to_the_atom() {
    let n: usize = std::env::var("CROSS_FUZZ").ok().and_then(|v| v.parse().ok()).unwrap_or(40);
    let seed: u64 = std::env::var("CROSS_FUZZ_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(0xB311_C055);
    let mut g = Lcg(seed);
    let mut env = CrossEnv::new();
    let mut day = DAY;
    let (mut filled_raw, mut regimes) = (0u128, [0usize; 3]);

    for i in 0..n {
        // the next trading day's close
        let close = loop {
            if let Some((_, c)) = day_session_bounds(day) {
                break c;
            }
            day += 1;
        };
        let price_e8: u64 = g.range(50_00_000_000, 900_00_000_000); // $50–900
        let x = xstock::price_per_raw_wad(price_e8 as i64, -8, M_WAD, 6, 8).unwrap();

        // the book, placed an hour before the close
        env.bell.set_time(close - 3_600);
        let mut parties: Vec<Party> = Vec::new();
        for side in [BUY, SELL] {
            for _ in 0..g.range(1, 6) {
                let amount = if side == BUY { g.range(USDC_1, 20_000 * USDC_1) } else { g.range(NVDAX_1 / 100, 40 * NVDAX_1) };
                // a limit a third of the time, on either side of the print
                let limit_e8 = if g.chance(33) { (price_e8 as f64 * (0.9 + g.range(0, 200) as f64 / 1_000.0)) as u64 } else { 0 };
                let key = if side == BUY { env.trader(0, amount) } else { env.trader(amount, 0) };
                let (raw0, quote0) = (env.balance(&env.raw_ata(&key.pubkey())), env.balance(&env.quote_ata(&key.pubkey())));
                ok(env.place(&key, day, CLOSE_KIND, 0, side, amount, limit_e8), "place");
                parties.push(Party { key, side, amount, limit_e8, raw0, quote0 });
            }
        }

        // the print
        env.bell.set_time(close + 1);
        let feed_ts = close as u64 * US - g.range(1, 9_000_000);
        let e = Equity { price: price_e8 as i64, ..Equity::at(feed_ts) };
        let ts = feed_ts + 150_000;
        let msg = sign(&env.bell.signer, payload(ts, vec![(EQUITY, e.props()), (RR, simple(100_170_000, ts))]));
        ok(env.bell.post(&msg, day, CLOSE_KIND), "post the print");
        env.bell.set_time(close + 300);
        ok(env.bell.finalize(day, CLOSE_KIND), "finalize");
        ok(env.price(day, CLOSE_KIND), "price");

        let cross = env.cross_addr(day, CLOSE_KIND);
        let orders: Vec<Address> = parties.iter().map(|p| env.order_addr(&cross, &p.key.pubkey(), 0)).collect();
        for chunk in orders.chunks(6) {
            ok(env.confirm(day, CLOSE_KIND, chunk), "confirm");
        }
        let v = CrossView::read(&env, day, CLOSE_KIND).unwrap();
        let in_band = |p: &Party| p.limit_e8 == 0 || if p.side == BUY { price_e8 <= p.limit_e8 } else { price_e8 >= p.limit_e8 };
        let b: u128 = parties.iter().filter(|p| p.side == BUY && in_band(p)).map(|p| p.amount as u128).sum();
        let s: u128 = parties.iter().filter(|p| p.side == SELL && in_band(p)).map(|p| p.amount as u128).sum();
        assert_eq!((v.buy_in as u128, v.sell_in as u128), (b, s), "cross {i}: the in-band book");

        // makers, on the crowded side
        let mut ladder = [0u64; math::LADDER];
        let mut makers: Vec<(Keypair, u8, u64, u16, u64, u64)> = Vec::new();
        if v.phase == AUCTION {
            for _ in 0..g.range(0, 4) {
                let fee = g.range(0, 101) as u16;
                let (side, size) = if v.crowded == 1 { (SELL, g.range(NVDAX_1 / 100, 30 * NVDAX_1)) } else { (BUY, g.range(USDC_1, 15_000 * USDC_1)) };
                let key = if side == SELL { env.trader(size, 0) } else { env.trader(0, size) };
                let (raw0, quote0) = (env.balance(&env.raw_ata(&key.pubkey())), env.balance(&env.quote_ata(&key.pubkey())));
                ok(env.offer(&key, day, CLOSE_KIND, 0, side, size, fee), "offer");
                ladder[fee as usize] += size;
                makers.push((key, side, size, fee, raw0, quote0));
            }
            env.bell.set_time(v.auction_end);
            ok(env.clear(day, CLOSE_KIND), "clear");
        }
        let want = math::clear(x, b, s, &ladder).unwrap();
        let got = CrossView::read(&env, day, CLOSE_KIND).unwrap();
        assert_eq!(got.clearing, want, "cross {i}: the program's clearing");
        regimes[match want.crowded { math::Crowded::Balanced => 0, math::Crowded::Buyers => 1, math::Crowded::Sellers => 2 }] += 1;

        for p in &parties {
            ok(env.settle_order(day, CLOSE_KIND, &p.key.pubkey(), 0, LEGS), "settle");
            let raw = env.balance(&env.raw_ata(&p.key.pubkey())) as i128 - p.raw0 as i128;
            let quote = env.balance(&env.quote_ata(&p.key.pubkey())) as i128 - p.quote0 as i128;
            let expect = if !in_band(p) {
                (0, 0)
            } else if p.side == BUY {
                let (spent, got) = math::buyer_leg(p.amount as u128, &want).unwrap();
                filled_raw += got;
                (got as i128, -(spent as i128))
            } else {
                let (spent, got) = math::seller_leg(p.amount as u128, &want).unwrap();
                (-(spent as i128), got as i128)
            };
            assert_eq!((raw, quote), expect, "cross {i}: a {} of {} (limit {})", if p.side == BUY { "buy" } else { "sell" }, p.amount, p.limit_e8);
        }
        for (key, side, size, fee, raw0, quote0) in &makers {
            ok(env.settle_offer(day, CLOSE_KIND, &key.pubkey(), 0, LEGS), "settle an offer");
            let raw = env.balance(&env.raw_ata(&key.pubkey())) as i128 - *raw0 as i128;
            let quote = env.balance(&env.quote_ata(&key.pubkey())) as i128 - *quote0 as i128;
            let (given, got) = math::maker_leg(*size as u128, *fee, &want).unwrap();
            let expect = if *side == SELL { (-(given as i128), got as i128) } else { (got as i128, -(given as i128)) };
            assert_eq!((raw, quote), expect, "cross {i}: a maker of {size} at {fee} bp");
        }
        ok(env.close_cross(day, CLOSE_KIND), "close");
        assert_eq!((env.balance(&env.raw_escrow), env.balance(&env.quote_escrow)), (0, 0), "cross {i}: escrow empty after close");
        day += 1;
    }
    println!(
        "ok {n} randomised crosses on chain match the arithmetic to the atom ({} balanced, {} buyers crowded, {} sellers crowded; {} raw atoms to buyers)",
        regimes[0], regimes[1], regimes[2], filled_raw
    );
}
