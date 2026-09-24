//! session-cross end to end, on the real NVDAx mint, priced by a print Pyth's
//! own verifier checked.
//!
//! Every balance change is compared, to the atom, with what
//! `session_core::cross` computes from the same book. The program is held to
//! the pure arithmetic its property tests cover, and that arithmetic to
//! tokens really moving through Token-2022.

use bell_integration::cross::*;
use bell_integration::*;
use session_core::cross as math;
use session_core::fixed::WAD;
use session_core::xstock;
use solana_signer::Signer;

/// The real NVDAx multiplier in force at the 24 Sep close.
const M_WAD: u128 = 1_001_701_196_801_074_056;

fn x_wad() -> u128 {
    // the harness's print: 224.06 as 22_406_000_000 × 10⁻⁸
    xstock::price_per_raw_wad(22_406_000_000, -8, M_WAD, 6, 8).unwrap()
}

fn close_at() -> Equity {
    Equity::at(CLOSE as u64 * US - 200_000)
}

struct Trader {
    key: solana_keypair::Keypair,
    raw0: u64,
    quote0: u64,
}

impl Trader {
    fn new(env: &mut CrossEnv, nvdax: u64, usdc: u64) -> Trader {
        let key = env.trader(nvdax, usdc);
        let (raw0, quote0) = (env.balance(&env.raw_ata(&key.pubkey())), env.balance(&env.quote_ata(&key.pubkey())));
        Trader { key, raw0, quote0 }
    }
    /// (raw, quote) change since the start, signed.
    fn delta(&self, env: &CrossEnv) -> (i128, i128) {
        let raw = env.balance(&env.raw_ata(&self.key.pubkey())) as i128 - self.raw0 as i128;
        let quote = env.balance(&env.quote_ata(&self.key.pubkey())) as i128 - self.quote0 as i128;
        (raw, quote)
    }
}

#[test]
fn a_full_cross_nets_at_the_print_and_auctions_the_rest() {
    let mut env = CrossEnv::new();
    let alice = Trader::new(&mut env, 0, 2_000 * USDC_1);
    let bob = Trader::new(&mut env, 0, 2_000 * USDC_1);
    let dan = Trader::new(&mut env, 0, 2_000 * USDC_1);
    let carol = Trader::new(&mut env, 10 * NVDAX_1, 0);
    let erin = Trader::new(&mut env, 10 * NVDAX_1, 0);
    let m1 = Trader::new(&mut env, 20 * NVDAX_1, 0);
    let m2 = Trader::new(&mut env, 20 * NVDAX_1, 0);

    env.bell.set_time(CLOSE - 3_600);
    ok(env.place(&alice.key, DAY, CLOSE_KIND, 0, BUY, 1_000 * USDC_1, 0), "alice buys $1,000 at the close");
    ok(env.place(&bob.key, DAY, CLOSE_KIND, 0, BUY, 500 * USDC_1, 230_00_000_000), "bob buys $500 if NVDA ≤ 230");
    ok(env.place(&dan.key, DAY, CLOSE_KIND, 0, BUY, 300 * USDC_1, 220_00_000_000), "dan buys $300 if NVDA ≤ 220");
    ok(env.place(&carol.key, DAY, CLOSE_KIND, 0, SELL, 2 * NVDAX_1, 200_00_000_000), "carol sells 2 if NVDA ≥ 200");
    ok(env.place(&erin.key, DAY, CLOSE_KIND, 0, SELL, NVDAX_1, 230_00_000_000), "erin sells 1 if NVDA ≥ 230");
    let v = CrossView::read(&env, DAY, CLOSE_KIND).unwrap();
    assert_eq!((v.phase, v.n_orders, v.bell_ts), (COLLECTING, 5, CLOSE));

    env.ring_close(&close_at());
    ok(env.price(DAY, CLOSE_KIND), "price the cross");
    let v = CrossView::read(&env, DAY, CLOSE_KIND).unwrap();
    assert_eq!(v.phase, CONFIRMING);
    assert_eq!(v.multiplier_wad, M_WAD, "the real mint's multiplier at the bell");
    assert_eq!(v.price_wad, x_wad());
    assert_eq!(v.price_e8, 224_06_000_000);
    assert!(!v.simulated);

    let cross = env.cross_addr(DAY, CLOSE_KIND);
    let orders: Vec<Address> = [&alice, &bob, &dan, &carol, &erin].iter().map(|t| env.order_addr(&cross, &t.key.pubkey(), 0)).collect();
    ok(env.confirm(DAY, CLOSE_KIND, &orders), "confirm the book");
    let v = CrossView::read(&env, DAY, CLOSE_KIND).unwrap();
    assert_eq!((v.buy_in, v.sell_in), (1_500 * USDC_1, 2 * NVDAX_1), "dan and erin are out of band");
    assert_eq!((v.phase, v.crowded), (AUCTION, 1), "buyers crowded");
    assert_eq!(v.auction_end, CLOSE + 300 + 120);

    ok(env.offer(&m1.key, DAY, CLOSE_KIND, 0, SELL, 5 * NVDAX_1, 15), "m1 offers 5 NVDAx at 15 bp");
    ok(env.offer(&m2.key, DAY, CLOSE_KIND, 0, SELL, 5 * NVDAX_1, 40), "m2 offers 5 NVDAx at 40 bp");
    refused(env.offer(&alice.key, DAY, CLOSE_KIND, 1, BUY, 100 * USDC_1, 5), "Error Code: WrongSide.");
    refused(env.offer(&m1.key, DAY, CLOSE_KIND, 1, SELL, NVDAX_1, 101), "Error Code: FeeTooHigh.");
    refused(env.clear(DAY, CLOSE_KIND), "Error Code: AuctionOpen.");
    refused(env.settle_order(DAY, CLOSE_KIND, &alice.key.pubkey(), 0, LEGS), "Error Code: NotSettling.");

    env.bell.set_time(CLOSE + 420);
    ok(env.clear(DAY, CLOSE_KIND), "clear");
    let v = CrossView::read(&env, DAY, CLOSE_KIND).unwrap();
    let mut ladder = [0u64; math::LADDER];
    ladder[15] = 5 * NVDAX_1;
    ladder[40] = 5 * NVDAX_1;
    let want = math::clear(x_wad(), 1_500 * USDC_1 as u128, 2 * NVDAX_1 as u128, &ladder).unwrap();
    assert_eq!(v.clearing, want, "the program clears exactly as session-core does");
    assert_eq!((v.phase, v.clearing.fee_bps, v.clearing.marginal_fee_bps), (SETTLING, 15, 15));

    for t in [&alice, &bob, &dan, &carol, &erin] {
        ok(env.settle_order(DAY, CLOSE_KIND, &t.key.pubkey(), 0, LEGS), "settle an order");
    }
    for m in [&m1, &m2] {
        ok(env.settle_offer(DAY, CLOSE_KIND, &m.key.pubkey(), 0, LEGS), "settle an offer");
    }

    let buyer = |b: u64| {
        let (spent, got) = math::buyer_leg(b as u128, &want).unwrap();
        (got as i128, -(spent as i128))
    };
    assert_eq!(alice.delta(&env), buyer(1_000 * USDC_1));
    assert_eq!(bob.delta(&env), buyer(500 * USDC_1));
    assert_eq!(dan.delta(&env), (0, 0), "out of band: refunded whole");
    let (spent, got) = math::seller_leg(2 * NVDAX_1 as u128, &want).unwrap();
    assert_eq!(carol.delta(&env), (-(spent as i128), got as i128));
    assert_eq!(erin.delta(&env), (0, 0), "out of band: refunded whole");
    let (given, got) = math::maker_leg(5 * NVDAX_1 as u128, 15, &want).unwrap();
    assert_eq!(m1.delta(&env), (-(given as i128), got as i128));
    assert_eq!(m2.delta(&env), (0, 0), "the 40 bp offer was not needed");

    // carol sold at exactly X, and the buyers paid at most X·(1 + 15 bp)
    let fair = 2 * NVDAX_1 as u128 * x_wad() / WAD;
    assert!(fair - got_of(&carol, &env) <= 1);
    println!("ok alice: {:?} raw/quote, carol: {:?}, m1: {:?}", alice.delta(&env), carol.delta(&env), m1.delta(&env));

    let v = CrossView::read(&env, DAY, CLOSE_KIND).unwrap();
    assert!(v.quote_out <= v.quote_in && v.raw_out <= v.raw_in);
    ok(env.close_cross(DAY, CLOSE_KIND), "close the cross");
    assert!(CrossView::read(&env, DAY, CLOSE_KIND).is_none(), "the cross account is gone");
    assert_eq!(env.balance(&env.raw_escrow), 0, "escrow emptied to the atom");
    assert_eq!(env.balance(&env.quote_escrow), 0);
    let t = env.treasury.pubkey();
    println!("ok dust to the treasury: {} raw, {} quote", env.balance(&env.raw_ata(&t)), env.balance(&env.quote_ata(&t)));
}

fn got_of(t: &Trader, env: &CrossEnv) -> u128 {
    t.delta(env).1 as u128
}

#[test]
fn crowded_sellers_are_bought_by_quote_makers() {
    let mut env = CrossEnv::new();
    let alice = Trader::new(&mut env, 0, 1_000 * USDC_1);
    let carol = Trader::new(&mut env, 20 * NVDAX_1, 0);
    let m = Trader::new(&mut env, 0, 5_000 * USDC_1);
    env.bell.set_time(CLOSE - 3_600);
    ok(env.place(&alice.key, DAY, CLOSE_KIND, 0, BUY, 500 * USDC_1, 0), "alice buys $500");
    ok(env.place(&carol.key, DAY, CLOSE_KIND, 0, SELL, 10 * NVDAX_1, 0), "carol sells 10");
    env.ring_close(&close_at());
    ok(env.price(DAY, CLOSE_KIND), "price");
    let cross = env.cross_addr(DAY, CLOSE_KIND);
    let orders = [env.order_addr(&cross, &alice.key.pubkey(), 0), env.order_addr(&cross, &carol.key.pubkey(), 0)];
    ok(env.confirm(DAY, CLOSE_KIND, &orders), "confirm");
    assert_eq!(CrossView::read(&env, DAY, CLOSE_KIND).unwrap().crowded, 2, "sellers crowded");
    ok(env.offer(&m.key, DAY, CLOSE_KIND, 0, BUY, 3_000 * USDC_1, 20), "a quote maker at 20 bp");
    env.bell.set_time(CLOSE + 420);
    ok(env.clear(DAY, CLOSE_KIND), "clear");
    let mut ladder = [0u64; math::LADDER];
    ladder[20] = 3_000 * USDC_1;
    let want = math::clear(x_wad(), 500 * USDC_1 as u128, 10 * NVDAX_1 as u128, &ladder).unwrap();
    assert_eq!(CrossView::read(&env, DAY, CLOSE_KIND).unwrap().clearing, want);
    for (who, n) in [(&alice, 0u16), (&carol, 0)] {
        ok(env.settle_order(DAY, CLOSE_KIND, &who.key.pubkey(), n, LEGS), "settle");
    }
    ok(env.settle_offer(DAY, CLOSE_KIND, &m.key.pubkey(), 0, LEGS), "settle the maker");
    let (spent, got) = math::buyer_leg(500 * USDC_1 as u128, &want).unwrap();
    assert_eq!(alice.delta(&env), (got as i128, -(spent as i128)), "the buyer fills in full at X");
    let (spent, got) = math::seller_leg(10 * NVDAX_1 as u128, &want).unwrap();
    assert_eq!(carol.delta(&env), (-(spent as i128), got as i128));
    let (given, got) = math::maker_leg(3_000 * USDC_1 as u128, 20, &want).unwrap();
    assert_eq!(m.delta(&env), (got as i128, -(given as i128)));
    ok(env.close_cross(DAY, CLOSE_KIND), "close");
    assert_eq!((env.balance(&env.raw_escrow), env.balance(&env.quote_escrow)), (0, 0));
    println!("ok crowded sellers: carol {:?}, the maker {:?}", carol.delta(&env), m.delta(&env));
}

#[test]
fn a_missing_print_refunds_everyone_whole() {
    let mut env = CrossEnv::new();
    let alice = Trader::new(&mut env, 0, 1_000 * USDC_1);
    let carol = Trader::new(&mut env, 5 * NVDAX_1, 0);
    env.bell.set_time(CLOSE - 3_600);
    ok(env.place(&alice.key, DAY, CLOSE_KIND, 0, BUY, 700 * USDC_1, 0), "alice");
    ok(env.place(&carol.key, DAY, CLOSE_KIND, 0, SELL, 3 * NVDAX_1, 0), "carol");
    env.bell.set_time(CLOSE + 300);
    ok(env.bell.mark_missing(DAY, CLOSE_KIND), "nobody posted the close");
    ok(env.price(DAY, CLOSE_KIND), "price_cross reads the missing print");
    assert_eq!(CrossView::read(&env, DAY, CLOSE_KIND).unwrap().phase, CANCELLED);
    ok(env.settle_order(DAY, CLOSE_KIND, &alice.key.pubkey(), 0, LEGS), "refund alice");
    ok(env.settle_order(DAY, CLOSE_KIND, &carol.key.pubkey(), 0, LEGS), "refund carol");
    assert_eq!(alice.delta(&env), (0, 0));
    assert_eq!(carol.delta(&env), (0, 0));
    ok(env.close_cross(DAY, CLOSE_KIND), "close");
    println!("ok a missing print cancels the cross and refunds everyone whole");
}

#[test]
fn a_cross_with_no_print_at_all_can_be_cancelled_after_six_hours() {
    let mut env = CrossEnv::new();
    let alice = Trader::new(&mut env, 0, 1_000 * USDC_1);
    env.bell.set_time(CLOSE - 3_600);
    ok(env.place(&alice.key, DAY, CLOSE_KIND, 0, BUY, 700 * USDC_1, 0), "alice");
    env.bell.set_time(CLOSE + 21_600);
    refused(env.cancel_cross(DAY, CLOSE_KIND), "Error Code: TooEarlyToCancel.");
    env.bell.set_time(CLOSE + 21_601);
    ok(env.cancel_cross(DAY, CLOSE_KIND), "cancel");
    ok(env.settle_order(DAY, CLOSE_KIND, &alice.key.pubkey(), 0, LEGS), "refund");
    assert_eq!(alice.delta(&env), (0, 0));
    println!("ok a cross nobody can price is cancelled after six hours, refunds whole");
}

#[test]
fn the_book_freezes_two_minutes_before_the_bell() {
    let mut env = CrossEnv::new();
    let alice = Trader::new(&mut env, 0, 1_000 * USDC_1);
    env.bell.set_time(CLOSE - 121);
    ok(env.place(&alice.key, DAY, CLOSE_KIND, 0, BUY, 100 * USDC_1, 0), "121 s before the close");
    ok(env.place(&alice.key, DAY, CLOSE_KIND, 1, BUY, 100 * USDC_1, 0), "a second order");
    ok(env.cancel(&alice.key, DAY, CLOSE_KIND, 1, BUY), "cancel before the freeze");
    env.bell.set_time(CLOSE - 120);
    refused(env.place(&alice.key, DAY, CLOSE_KIND, 2, BUY, 100 * USDC_1, 0), "Error Code: Frozen.");
    refused(env.cancel(&alice.key, DAY, CLOSE_KIND, 0, BUY), "Error Code: Frozen.");
    let v = CrossView::read(&env, DAY, CLOSE_KIND).unwrap();
    assert_eq!((v.n_orders, alice.delta(&env)), (1, (0, -(100 * USDC_1 as i128))), "one order stands, one came back");
    println!("ok the book freezes 120 s before the bell; a cancel before it returns the escrow");
}

#[test]
fn only_the_owner_cancels_and_no_bell_no_order() {
    let mut env = CrossEnv::new();
    let alice = Trader::new(&mut env, 0, 1_000 * USDC_1);
    let bob = Trader::new(&mut env, 0, 1_000 * USDC_1);
    env.bell.set_time(CLOSE - 3_600);
    ok(env.place(&alice.key, DAY, CLOSE_KIND, 0, BUY, 100 * USDC_1, 0), "alice");
    // bob signs a cancel of alice's order, pointing at his own token account
    let cross = env.cross_addr(DAY, CLOSE_KIND);
    let ix = Instruction {
        program_id: env.program,
        accounts: vec![
            AccountMeta::new(bob.key.pubkey(), true),
            AccountMeta::new_readonly(env.market, false),
            AccountMeta::new(cross, false),
            AccountMeta::new(env.order_addr(&cross, &alice.key.pubkey(), 0), false),
            AccountMeta::new_readonly(env.usdc, false),
            AccountMeta::new(env.quote_ata(&bob.key.pubkey()), false),
            AccountMeta::new(env.quote_escrow, false),
            AccountMeta::new_readonly(addr(SPL_TOKEN), false),
        ],
        data: disc("global", "cancel_order").to_vec(),
    };
    let b = bob.key.insecure_clone();
    refused(env.send_as(&b, &[ix]), "Error Code: NotOwner.");
    refused(env.place(&alice.key, SATURDAY, CLOSE_KIND, 1, BUY, 100 * USDC_1, 0), "Error Code: NoBell.");
    refused(env.place(&alice.key, DAY, CLOSE_KIND, 2, BUY, USDC_1 - 1, 0), "Error Code: OrderTooSmall.");
    refused(env.place(&alice.key, DAY, CLOSE_KIND, 3, 7, 100 * USDC_1, 0), "Error Code: BadSide.");
    println!("ok only the owner cancels; no bell, no order; minimums hold");
}

#[test]
fn an_issuer_pause_delays_tokens_but_never_a_quote_refund() {
    let mut env = CrossEnv::new();
    let alice = Trader::new(&mut env, 0, 1_000 * USDC_1);
    let carol = Trader::new(&mut env, 5 * NVDAX_1, 0);
    env.bell.set_time(CLOSE - 3_600);
    // buyers crowded with no maker: alice is filled in part and refunded the rest
    ok(env.place(&alice.key, DAY, CLOSE_KIND, 0, BUY, 1_000 * USDC_1, 0), "alice");
    ok(env.place(&carol.key, DAY, CLOSE_KIND, 0, SELL, NVDAX_1, 0), "carol");
    env.ring_close(&close_at());
    ok(env.price(DAY, CLOSE_KIND), "price");
    let cross = env.cross_addr(DAY, CLOSE_KIND);
    let orders = [env.order_addr(&cross, &alice.key.pubkey(), 0), env.order_addr(&cross, &carol.key.pubkey(), 0)];
    ok(env.confirm(DAY, CLOSE_KIND, &orders), "confirm");
    env.bell.set_time(CLOSE + 420);
    ok(env.clear(DAY, CLOSE_KIND), "clear");

    env.set_paused(true);
    refused(env.settle_order(DAY, CLOSE_KIND, &alice.key.pubkey(), 0, LEGS), "paused");
    ok(env.settle_order(DAY, CLOSE_KIND, &alice.key.pubkey(), 0, LEG_QUOTE), "the quote refund still settles");
    let (raw, quote) = alice.delta(&env);
    assert!(raw == 0 && quote > -(1_000 * USDC_1 as i128), "refunded while paused: {quote}");
    refused(env.place(&alice.key, DAY + 1, CLOSE_KIND, 0, BUY, 100 * USDC_1, 0), "Error Code: MintRefusesEscrow.");

    env.set_paused(false);
    ok(env.settle_order(DAY, CLOSE_KIND, &alice.key.pubkey(), 0, LEG_RAW), "the tokens, once unpaused");
    ok(env.settle_order(DAY, CLOSE_KIND, &carol.key.pubkey(), 0, LEGS), "carol");
    let want = math::clear(x_wad(), 1_000 * USDC_1 as u128, NVDAX_1 as u128, &[0; math::LADDER]).unwrap();
    let (spent, got) = math::buyer_leg(1_000 * USDC_1 as u128, &want).unwrap();
    assert_eq!(alice.delta(&env), (got as i128, -(spent as i128)));
    ok(env.close_cross(DAY, CLOSE_KIND), "close");
    println!("ok a pause held the tokens, not the refund; nothing new entered while paused");
}

#[test]
fn a_multiplier_activation_near_the_bell_cancels_the_cross() {
    let mut env = CrossEnv::new();
    let alice = Trader::new(&mut env, 0, 1_000 * USDC_1);
    env.bell.set_time(CLOSE - 3_600);
    ok(env.place(&alice.key, DAY, CLOSE_KIND, 0, BUY, 100 * USDC_1, 0), "alice");
    env.ring_close(&close_at());
    // the issuer schedules a new multiplier a minute before the close
    env.edit_mint(|d| {
        let at = extension(d, 25).unwrap();
        d[at + 40..at + 48].copy_from_slice(&(CLOSE - 60).to_le_bytes());
    });
    ok(env.price(DAY, CLOSE_KIND), "price_cross refuses to guess");
    assert_eq!(CrossView::read(&env, DAY, CLOSE_KIND).unwrap().phase, CANCELLED);
    ok(env.settle_order(DAY, CLOSE_KIND, &alice.key.pubkey(), 0, LEGS), "refund");
    assert_eq!(alice.delta(&env), (0, 0));
    println!("ok a multiplier activating within 15 min of the bell cancels the cross");
}

#[test]
fn pyths_redemption_rate_must_agree_with_the_mint() {
    let mut env = CrossEnv::new();
    let alice = Trader::new(&mut env, 0, 1_000 * USDC_1);
    env.bell.set_time(CLOSE - 3_600);
    ok(env.place(&alice.key, DAY, CLOSE_KIND, 0, BUY, 100 * USDC_1, 0), "alice");
    // a print whose .RR says 1.0100 against the mint's 1.0017
    env.bell.set_time(CLOSE + 1);
    let e = close_at();
    let ts = e.feed_ts + 150_000;
    let msg = sign(&env.bell.signer, payload(ts, vec![(EQUITY, e.props()), (RR, simple(101_000_000, ts))]));
    ok(env.bell.post(&msg, DAY, CLOSE_KIND), "post");
    env.bell.set_time(CLOSE + 300);
    ok(env.bell.finalize(DAY, CLOSE_KIND), "finalize");
    ok(env.price(DAY, CLOSE_KIND), "price_cross cross-checks the rate");
    assert_eq!(CrossView::read(&env, DAY, CLOSE_KIND).unwrap().phase, CANCELLED);
    println!("ok Pyth's .RR disagreeing with the mint's multiplier cancels the cross");
}
