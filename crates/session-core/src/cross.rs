//! The cross: every order at one price, and an auction for the difference.
//!
//! At a bell, buyers (who escrowed quote) and sellers (who escrowed raw
//! tokens) are netted at `X`, the price of one raw atom (`xstock.rs`). If one
//! side is larger, makers fill the difference: a token offer for crowded
//! buyers, a quote offer for crowded sellers, each asking a fee from 0 to
//! `MAX_FEE_BPS`. The clearing fee `f` is the lowest at which the offers asking
//! at most `f` cover the imbalance. Every filling maker trades at `X·(1 ± f)`,
//! and offers are rationed lowest ask first. `docs/CROSS.md` states it in full.
//!
//! [`clear`] runs once per cross and fixes a handful of totals. Each order and
//! offer is then settled on its own by [`buyer_leg`], [`seller_leg`] or
//! [`maker_leg`], from those totals alone. Settlement order cannot change
//! anyone's result. Rounding always favours escrow:
//!
//! - what an order *gives up* rounds up, and what it *receives* rounds down;
//! - no order gives up more than it escrowed;
//! - every total an order is paid from is at least the sum of the
//!   rounded-down shares drawn from it.
//!
//! So for every cross and each token, `paid out + refunded ≤ escrowed`. The
//! property tests below check that, and that the leftover dust is at most a
//! couple of atoms per participant, over 10,000 random crosses.

use crate::fixed::{mul_div_ceil, mul_div_floor, WAD};

pub const BPS: u128 = 10_000;
/// The highest fee a maker may ask. The ladder has one bucket per basis point.
pub const MAX_FEE_BPS: usize = 100;
pub const LADDER: usize = MAX_FEE_BPS + 1;

/// Makers' capacity by fee: `ladder[f]` is the total offered at exactly `f`
/// bp. Raw atoms when buyers are crowded, quote atoms when sellers are.
pub type Ladder = [u64; LADDER];

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Crowded {
    /// Both sides fill at `X`, or the book is empty.
    #[default]
    Balanced,
    Buyers,
    Sellers,
}

/// What `clear` fixes. Every leg is computed from these alone.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Clearing {
    pub crowded: Crowded,
    /// `X`, quote atoms per raw atom, WAD.
    pub price_wad: u128,
    /// The clearing fee, in basis points. Zero unless a side is crowded.
    pub fee_bps: u16,
    /// What makers trade at, WAD: `X·(1+f)` rounded down when they sell to
    /// crowded buyers, `X·(1−f)` rounded up when they buy from crowded sellers.
    pub maker_price_wad: u128,
    /// Offers asking less than this fill in full, those asking more do not
    /// fill, and those asking exactly this fill `marginal_need / marginal_cap`.
    pub marginal_fee_bps: u16,
    pub marginal_need: u128,
    pub marginal_cap: u128,
    /// In-band buyers' escrow `B`, what is taken from it in total, and the
    /// raw atoms they receive in total.
    pub buy_in: u128,
    pub buy_spent: u128,
    pub buy_tokens: u128,
    /// In-band sellers' escrow `S`, what is taken from it in total, and the
    /// quote they receive in total.
    pub sell_in: u128,
    pub sell_spent: u128,
    pub sell_quote: u128,
}

/// `X·(BPS ± f)/BPS`: floor when makers sell (buyers crowded), ceil when
/// makers buy (sellers crowded). Either way the maker's rounding costs the
/// maker, not the escrow.
fn maker_price(x_wad: u128, fee: usize, crowded: Crowded) -> Option<u128> {
    match crowded {
        Crowded::Buyers => mul_div_floor(x_wad, BPS + fee as u128, BPS),
        Crowded::Sellers => mul_div_ceil(x_wad, BPS - fee as u128, BPS),
        Crowded::Balanced => Some(x_wad),
    }
}

/// The clearing fee: the lowest fee somebody *asked* at which the offers
/// asking at most that meet what is needed at it. `need(k)` falls as `k`
/// rises (makers give more per unit at a higher fee), so without the
/// restriction to real asks, a ladder that falls short would clear at a fee
/// nobody asked for, charged to the crowded side for the same offers.
/// `None` if even the highest ask falls short. An imbalance that rounds to
/// nothing needs no maker and clears at zero.
fn find_fee(ladder: &Ladder, need: impl Fn(usize) -> Option<u128>) -> Option<Option<(usize, u128)>> {
    if need(0)? == 0 {
        return Some(Some((0, 0)));
    }
    let mut cum: u128 = 0;
    for (k, cap) in ladder.iter().enumerate() {
        if *cap == 0 {
            continue;
        }
        cum += *cap as u128;
        let n = need(k)?;
        if cum >= n {
            return Some(Some((k, n)));
        }
    }
    Some(None)
}

/// Which bucket is rationed when `need` must be met from the ladder: the
/// lowest `m` whose cumulative capacity reaches it.
fn marginal(ladder: &Ladder, need: u128) -> (usize, u128, u128) {
    let mut below: u128 = 0;
    for (m, cap) in ladder.iter().enumerate() {
        let cap = *cap as u128;
        if below + cap >= need {
            return (m, need - below, cap);
        }
        below += cap;
    }
    // unreachable when `need` ≤ the ladder's total, which callers guarantee
    (MAX_FEE_BPS, 0, 0)
}

/// The highest fee anyone asked, for an auction that falls short.
fn top_fee(ladder: &Ladder) -> usize {
    ladder.iter().rposition(|c| *c > 0).unwrap_or(0)
}

/// Clear a cross: in-band buyers' quote `buy_in`, in-band sellers' raw atoms
/// `sell_in`, price `x_wad`, and the makers' ladder on the crowded side.
/// `None` only on arithmetic overflow, which per-market caps rule out.
pub fn clear(x_wad: u128, buy_in: u128, sell_in: u128, ladder: &Ladder) -> Option<Clearing> {
    if x_wad == 0 {
        return None;
    }
    let base = Clearing { price_wad: x_wad, buy_in, sell_in, ..Clearing::default() };
    // B and S·X at a common WAD scale, exactly
    let b_wad = buy_in.checked_mul(WAD)?;
    let sx_wad = sell_in.checked_mul(x_wad)?;

    if b_wad == sx_wad {
        return Some(Clearing {
            maker_price_wad: x_wad,
            buy_spent: buy_in,
            buy_tokens: sell_in,
            sell_spent: sell_in,
            sell_quote: buy_in,
            ..base
        });
    }

    if b_wad > sx_wad {
        // Buyers crowded. Sellers fill in full at X; the buyers' remainder
        // R = B − S·X buys from makers at X·(1+f).
        let r_wad = b_wad - sx_wad;
        let crowded = Crowded::Buyers;
        let need = |k: usize| -> Option<u128> { Some(r_wad / maker_price(x_wad, k, crowded)?) };
        let (fee, supplied) = match find_fee(ladder, need)? {
            Some((k, n)) => (k, n),
            None => {
                let k = top_fee(ladder);
                (k, ladder.iter().map(|c| *c as u128).sum())
            }
        };
        let price = maker_price(x_wad, fee, crowded)?;
        let (m, need_m, cap_m) = marginal(ladder, supplied);
        // everything the buyers pay for, rounded up once: ≤ B, because
        // supplied × price ≤ R by construction
        let spent_wad = sx_wad.checked_add(supplied.checked_mul(price)?)?;
        let buy_spent = spent_wad.div_ceil(WAD);
        debug_assert!(buy_spent <= buy_in);
        return Some(Clearing {
            crowded,
            fee_bps: fee as u16,
            maker_price_wad: price,
            marginal_fee_bps: m as u16,
            marginal_need: need_m,
            marginal_cap: cap_m,
            buy_spent,
            buy_tokens: sell_in.checked_add(supplied)?,
            sell_spent: sell_in,
            sell_quote: sx_wad / WAD,
            ..base
        });
    }

    // Sellers crowded. Buyers fill in full at X; makers buy what is left of
    // the sellers' tokens, paying X·(1−f). What they must pay at fee k is
    // (S·X − B)·(1 − k), in quote atoms, rounded down.
    let excess_wad = sx_wad - b_wad;
    let crowded = Crowded::Sellers;
    let need = |k: usize| -> Option<u128> { mul_div_floor(excess_wad, BPS - k as u128, BPS * WAD) };
    let (fee, paid) = match find_fee(ladder, need)? {
        Some((k, n)) => (k, n),
        None => {
            let k = top_fee(ladder);
            (k, ladder.iter().map(|c| *c as u128).sum())
        }
    };
    let price = maker_price(x_wad, fee, crowded)?;
    let (m, need_m, cap_m) = marginal(ladder, paid);
    let buy_tokens = mul_div_floor(buy_in, WAD, x_wad)?;
    // Tokens the sellers give up: the buyers' B/X and the makers' paid/price,
    // rounded up once. ≤ S, because paid ≤ (S·X − B)(1 − f) ≤ (S − B/X)·price.
    let sell_spent = {
        // B·WAD/X + paid·WAD/price, as one ceiling over a common denominator
        let a = mul_div_ceil(buy_in, WAD, x_wad)?;
        let b = mul_div_ceil(paid, WAD, price)?;
        a.checked_add(b)?.min(sell_in)
    };
    Some(Clearing {
        crowded,
        fee_bps: fee as u16,
        maker_price_wad: price,
        marginal_fee_bps: m as u16,
        marginal_need: need_m,
        marginal_cap: cap_m,
        buy_spent: buy_in,
        buy_tokens,
        sell_spent,
        sell_quote: buy_in.checked_add(paid)?,
        ..base
    })
}

/// An in-band buyer who escrowed `b` quote: (quote given up, raw atoms received).
pub fn buyer_leg(b: u128, c: &Clearing) -> Option<(u128, u128)> {
    if c.buy_in == 0 {
        return Some((0, 0));
    }
    Some((mul_div_ceil(b, c.buy_spent, c.buy_in)?, mul_div_floor(b, c.buy_tokens, c.buy_in)?))
}

/// An in-band seller who escrowed `s` raw atoms: (raw atoms given up, quote received).
pub fn seller_leg(s: u128, c: &Clearing) -> Option<(u128, u128)> {
    if c.sell_in == 0 {
        return Some((0, 0));
    }
    Some((mul_div_ceil(s, c.sell_spent, c.sell_in)?, mul_div_floor(s, c.sell_quote, c.sell_in)?))
}

/// A maker's offer of `size` at `fee_bps`: (given up, received). Raw atoms
/// given for quote when buyers are crowded, quote given for raw atoms when
/// sellers are. Nothing fills on a balanced cross.
pub fn maker_leg(size: u128, fee_bps: u16, c: &Clearing) -> Option<(u128, u128)> {
    if c.crowded == Crowded::Balanced || fee_bps > c.marginal_fee_bps || size == 0 {
        return Some((0, 0));
    }
    let (filled, given) = if fee_bps < c.marginal_fee_bps {
        (size, size)
    } else if c.marginal_cap == 0 {
        (0, 0)
    } else {
        (
            mul_div_floor(size, c.marginal_need, c.marginal_cap)?,
            mul_div_ceil(size, c.marginal_need, c.marginal_cap)?,
        )
    };
    let received = match c.crowded {
        Crowded::Buyers => mul_div_floor(filled, c.maker_price_wad, WAD)?,
        Crowded::Sellers => mul_div_floor(filled, WAD, c.maker_price_wad)?,
        Crowded::Balanced => 0,
    };
    Some((given, received))
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const X: u128 = 2_244_411_701_552_486_529; // NVDA 224.06 × 1.0017, per raw atom

    fn ladder(offers: &[(usize, u64)]) -> Ladder {
        let mut l = [0u64; LADDER];
        for (f, c) in offers {
            l[*f] += c;
        }
        l
    }

    /// Every leg of a cross, and the conservation of both tokens.
    struct Outcome {
        quote_in: u128,
        quote_out: u128,
        raw_in: u128,
        raw_out: u128,
        parties: u128,
    }

    fn settle_all(c: &Clearing, buys: &[u128], sells: &[u128], offers: &[(usize, u64)]) -> Outcome {
        let (mut qi, mut qo, mut ri, mut ro) = (0u128, 0u128, 0u128, 0u128);
        for &b in buys {
            let (spent, got) = buyer_leg(b, c).unwrap();
            assert!(spent <= b, "a buyer gives up more than it escrowed");
            qi += b;
            qo += b - spent;
            ro += got;
        }
        for &s in sells {
            let (spent, got) = seller_leg(s, c).unwrap();
            assert!(spent <= s, "a seller gives up more than it escrowed");
            ri += s;
            ro += s - spent;
            qo += got;
        }
        for &(f, size) in offers {
            let size = size as u128;
            let (given, got) = maker_leg(size, f as u16, c).unwrap();
            assert!(given <= size, "a maker gives up more than it escrowed");
            match c.crowded {
                Crowded::Buyers => {
                    ri += size;
                    ro += size - given;
                    qo += got;
                }
                Crowded::Sellers => {
                    qi += size;
                    qo += size - given;
                    ro += got;
                }
                Crowded::Balanced => {
                    // no auction on a balanced cross: offers go back whole
                    assert_eq!((given, got), (0, 0));
                }
            }
        }
        Outcome { quote_in: qi, quote_out: qo, raw_in: ri, raw_out: ro, parties: (buys.len() + sells.len() + offers.len()) as u128 }
    }

    fn check(c: &Clearing, buys: &[u128], sells: &[u128], offers: &[(usize, u64)]) {
        let o = settle_all(c, buys, sells, offers);
        assert!(o.quote_out <= o.quote_in, "quote leaves escrow: {} > {} ({c:?})", o.quote_out, o.quote_in);
        assert!(o.raw_out <= o.raw_in, "tokens leave escrow: {} > {} ({c:?})", o.raw_out, o.raw_in);
        // And what stays behind is dust, not value: an atom or two per party,
        // plus what a maker's own rounding costs it. A marginal maker gives up
        // ⌈share⌉ and is paid for ⌊share⌋, at most one atom of the other token.
        let makers = offers.len() as u128 + 1;
        let one_raw_in_quote = c.price_wad.div_ceil(WAD);
        let one_quote_in_raw = WAD.div_ceil(c.price_wad.max(1));
        let quote_dust = o.quote_in - o.quote_out;
        let raw_dust = o.raw_in - o.raw_out;
        assert!(quote_dust <= 2 * o.parties + 2 + makers * one_raw_in_quote, "quote dust {quote_dust} for {} parties ({c:?})", o.parties);
        assert!(raw_dust <= 2 * o.parties + 2 + makers * one_quote_in_raw, "raw dust {raw_dust} for {} parties ({c:?})", o.parties);
    }

    #[test]
    fn a_balanced_book_trades_at_x_and_pays_no_fee() {
        // 3 buyers spend exactly what 2 sellers' tokens are worth: X per atom
        let x = 2 * WAD; // 2 quote atoms per raw atom
        let c = clear(x, 600, 300, &ladder(&[])).unwrap();
        assert_eq!((c.crowded, c.fee_bps), (Crowded::Balanced, 0));
        assert_eq!(buyer_leg(200, &c), Some((200, 100)));
        assert_eq!(seller_leg(150, &c), Some((150, 300)));
        check(&c, &[200, 200, 200], &[150, 150], &[]);
    }

    #[test]
    fn crowded_buyers_are_filled_by_the_cheapest_makers_at_one_price() {
        // X = 2. Buyers bring 1,000 quote, sellers 300 raw (worth 600): the
        // buyers' remaining 400 buys from makers. At 10 bp a raw atom costs
        // 2.002, so 199 atoms (398.4 quote) are needed.
        let x = 2 * WAD;
        let offers = [(10, 150u64), (10, 100), (20, 500), (5, 20)];
        let c = clear(x, 1_000, 300, &ladder(&offers)).unwrap();
        assert_eq!(c.crowded, Crowded::Buyers);
        assert_eq!(c.fee_bps, 10, "20 at 5 bp is not enough; 270 at ≤10 bp is");
        assert_eq!(c.maker_price_wad, 2_002_000_000_000_000_000);
        assert_eq!(c.buy_tokens, 300 + 199);
        assert_eq!(c.marginal_fee_bps, 10);
        assert_eq!((c.marginal_need, c.marginal_cap), (179, 250), "199 − the 20 at 5 bp, from the 250 at 10 bp");
        // sellers get exactly X
        assert_eq!(seller_leg(300, &c), Some((300, 600)));
        // the 5 bp maker fills in full at the clearing price, 10 bp pro rata, 20 bp not at all
        assert_eq!(maker_leg(20, 5, &c), Some((20, 40)));
        assert_eq!(maker_leg(500, 20, &c), Some((0, 0)));
        let (given, got) = maker_leg(150, 10, &c).unwrap();
        assert_eq!(given, 108, "ceil(150 × 179/250) = ceil(107.4)");
        assert_eq!(got, mul_div_floor(107, c.maker_price_wad, WAD).unwrap());
        check(&c, &[500, 300, 200], &[300], &offers);
    }

    #[test]
    fn crowded_sellers_are_bought_by_the_cheapest_makers() {
        // X = 2. Sellers bring 1,000 raw (worth 2,000), buyers 600 quote: 700
        // raw atoms are left. At 30 bp makers pay 1.994: 1,395.8 quote.
        let x = 2 * WAD;
        let offers = [(30, 2_000u64), (50, 5_000)];
        let c = clear(x, 600, 1_000, &ladder(&offers)).unwrap();
        assert_eq!((c.crowded, c.fee_bps), (Crowded::Sellers, 30));
        assert_eq!(c.maker_price_wad, 1_994_000_000_000_000_000);
        assert_eq!(buyer_leg(600, &c), Some((600, 300)), "buyers fill in full at X");
        assert_eq!(c.marginal_need, 1_395, "floor((2000 − 600) × 0.997)");
        check(&c, &[600], &[400, 600], &offers);
    }

    #[test]
    fn with_too_few_offers_the_crowded_side_is_filled_pro_rata() {
        let x = 2 * WAD;
        let offers = [(40, 50u64), (60, 50)];
        let c = clear(x, 1_000, 100, &ladder(&offers)).unwrap();
        assert_eq!(c.crowded, Crowded::Buyers);
        assert_eq!(c.fee_bps, 60, "everyone fills, at the highest ask");
        assert_eq!(c.buy_tokens, 200);
        // buyers spend 200 (sellers) + 100 × 2.012 (makers) = 401.2 → 402 of 1,000
        assert_eq!(c.buy_spent, 402);
        assert_eq!(maker_leg(50, 40, &c), Some((50, 100)), "the 40 bp maker is paid the uniform 60 bp price, floored");
        check(&c, &[600, 400], &[100], &offers);

        // no offers at all: buyers split the sellers' tokens
        let c = clear(x, 1_000, 100, &ladder(&[])).unwrap();
        assert_eq!((c.buy_tokens, c.buy_spent), (100, 200));
        check(&c, &[700, 300], &[100], &[]);
    }

    #[test]
    fn a_one_sided_book_clears_against_makers_alone() {
        let c = clear(X, 5_000_000, 0, &ladder(&[(15, 10_000_000)])).unwrap();
        assert_eq!(c.crowded, Crowded::Buyers);
        assert_eq!(c.fee_bps, 15);
        check(&c, &[5_000_000], &[], &[(15, 10_000_000)]);

        let c = clear(X, 0, 1_000_000_000, &ladder(&[(15, 1_000_000_000)])).unwrap();
        assert_eq!(c.crowded, Crowded::Sellers);
        check(&c, &[], &[1_000_000_000], &[(15, 1_000_000_000)]);

        let c = clear(X, 0, 0, &ladder(&[])).unwrap();
        assert_eq!(c.crowded, Crowded::Balanced);
        check(&c, &[], &[], &[]);
    }

    #[test]
    fn when_a_higher_price_makes_cheaper_offers_enough_the_dearer_ones_wait() {
        // Buyers need 10,000 quote of tokens at X = 100. At 0 bp that is 100
        // atoms and only 99 are offered; at 1 bp an atom costs 100.01 and 99
        // suffice. So the clearing fee is 1 bp, the 99 atoms asking 0 bp fill
        // in full at the 1 bp price, and the offer asking 1 bp is not needed.
        let x = 100 * WAD;
        let offers = [(0, 99u64), (1, 1_000)];
        let c = clear(x, 10_000, 0, &ladder(&offers)).unwrap();
        assert_eq!(c.fee_bps, 1);
        assert_eq!((c.marginal_fee_bps, c.marginal_need, c.marginal_cap), (0, 99, 99));
        assert_eq!(maker_leg(99, 0, &c), Some((99, 9_900)), "⌊99 × 100.01⌋");
        assert_eq!(maker_leg(1_000, 1, &c), Some((0, 0)));
        assert_eq!(c.buy_spent, 9_901, "⌈9,900.99⌉ of the 10,000");
        check(&c, &[10_000], &[], &offers);
    }

    /// A deterministic generator, so the vectors never change unless the
    /// arithmetic does.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            self.0 >> 11
        }
        fn range(&mut self, lo: u128, hi: u128) -> u128 {
            let r = ((self.next() as u128) << 53) | self.next() as u128;
            lo + r % (hi - lo)
        }
    }

    /// Writes `tests/vectors/cross.json`: 300 crosses across every regime,
    /// with the clearing and every leg, for `tests/cross.test.ts` to match.
    #[test]
    fn emit_cross_vectors() {
        let mut g = Lcg(0x5E55_10B3_11C0_55ED);
        let mut cases = Vec::new();
        for i in 0..300 {
            let x = g.range(1_000_000_000_000_000, 20_000_000_000_000_000_000);
            let nb = g.range(0, 7) as usize;
            let ns = g.range(0, 7) as usize;
            let buys: Vec<u128> = (0..nb).map(|_| g.range(1, 5_000_000_000)).collect();
            let sells: Vec<u128> = (0..ns).map(|_| g.range(1, 2_000_000_000)).collect();
            let no = g.range(0, 6) as usize;
            let offers: Vec<(usize, u64)> = (0..no)
                .map(|_| (g.range(0, LADDER as u128) as usize, g.range(1, 4_000_000_000) as u64))
                .collect();
            // every tenth case balanced exactly: sells worth exactly the buys
            let (x, buys, sells) = if i % 10 == 0 { (3 * WAD, vec![600, 300], vec![200, 100]) } else { (x, buys, sells) };
            let b: u128 = buys.iter().sum();
            let s: u128 = sells.iter().sum();
            let c = clear(x, b, s, &ladder(&offers)).unwrap();
            let pair = |p: (u128, u128)| format!("[\"{}\",\"{}\"]", p.0, p.1);
            let list = |v: &[u128]| v.iter().map(|q| format!("\"{q}\"")).collect::<Vec<_>>().join(",");
            let crowded = match c.crowded { Crowded::Balanced => "balanced", Crowded::Buyers => "buyers", Crowded::Sellers => "sellers" };
            cases.push(format!(
                "{{\"x\":\"{x}\",\"buys\":[{}],\"sells\":[{}],\"offers\":[{}],\"clearing\":{{\"crowded\":\"{crowded}\",\"fee_bps\":{},\"maker_price_wad\":\"{}\",\"marginal_fee_bps\":{},\"marginal_need\":\"{}\",\"marginal_cap\":\"{}\",\"buy_spent\":\"{}\",\"buy_tokens\":\"{}\",\"sell_spent\":\"{}\",\"sell_quote\":\"{}\"}},\"buyer_legs\":[{}],\"seller_legs\":[{}],\"maker_legs\":[{}]}}",
                list(&buys), list(&sells),
                offers.iter().map(|(f, q)| format!("[{f},\"{q}\"]")).collect::<Vec<_>>().join(","),
                c.fee_bps, c.maker_price_wad, c.marginal_fee_bps, c.marginal_need, c.marginal_cap,
                c.buy_spent, c.buy_tokens, c.sell_spent, c.sell_quote,
                buys.iter().map(|q| pair(buyer_leg(*q, &c).unwrap())).collect::<Vec<_>>().join(","),
                sells.iter().map(|q| pair(seller_leg(*q, &c).unwrap())).collect::<Vec<_>>().join(","),
                offers.iter().map(|(f, q)| pair(maker_leg(*q as u128, *f as u16, &c).unwrap())).collect::<Vec<_>>().join(","),
            ));
        }
        let json = format!(
            "{{\n \"note\": \"Generated by `cargo test -p session-core emit_cross_vectors`: clear() and every leg for 300 crosses.\",\n \"cases\": [\n  {}\n ]\n}}\n",
            cases.join(",\n  ")
        );
        std::fs::create_dir_all("../../tests/vectors").ok();
        std::fs::write("../../tests/vectors/cross.json", json).unwrap();
    }

    #[test]
    fn the_clearing_fee_is_one_somebody_asked() {
        // Found by the monotonicity property: every offer asks 0 bp and is a
        // little short at 0 bp. The price must not climb to a fee nobody asked
        // for just because a higher fee would make the same offers enough.
        let x = 5_203_794_056_043_118_580u128;
        let (b, s) = (1_134_558_634u128, 794_445_302u128);
        let c = clear(x, b, s, &ladder(&[(0, 2_969_575_395)])).unwrap();
        assert_eq!(c.crowded, Crowded::Sellers);
        assert_eq!(c.fee_bps, 0, "the only ask is 0 bp");
        assert!(c.sell_spent < s, "short at 0 bp: the sellers are rationed instead");
        check(&c, &[b], &[s], &[(0, 2_969_575_395)]);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// 10,000 random crosses: nothing leaves escrow that was not in it,
        /// nobody gives up more than they escrowed, and the dust is a couple
        /// of atoms per party.
        #[test]
        fn conservation(
            x in 1_000_000_000_000_000u128..20_000_000_000_000_000_000u128,
            buys in proptest::collection::vec(1u128..10_000_000_000u128, 0..12),
            sells in proptest::collection::vec(1u128..10_000_000_000u128, 0..12),
            offers in proptest::collection::vec((0usize..LADDER, 1u64..20_000_000_000u64), 0..10),
        ) {
            let b: u128 = buys.iter().sum();
            let s: u128 = sells.iter().sum();
            let c = clear(x, b, s, &ladder(&offers)).unwrap();
            prop_assert!(c.buy_spent <= b && c.sell_spent <= s);
            // offers only fill on the crowded side; posting on the other is
            // refused by the program, so a balanced cross ignores them
            check(&c, &buys, &sells, &offers);
        }

        /// More cheap capacity never raises the clearing fee.
        #[test]
        fn fee_monotone_in_capacity(
            x in 1_000_000_000_000_000u128..20_000_000_000_000_000_000u128,
            b in 1u128..10_000_000_000u128,
            s in 0u128..1_000_000_000u128,
            offers in proptest::collection::vec((0usize..LADDER, 1u64..2_000_000_000u64), 1..8),
            extra in 1u64..2_000_000_000u64,
            at in 0usize..LADDER,
        ) {
            let l1 = ladder(&offers);
            let mut l2 = l1;
            l2[at] += extra;
            let (c1, c2) = (clear(x, b, s, &l1).unwrap(), clear(x, b, s, &l2).unwrap());
            if c1.crowded == c2.crowded && c1.crowded != Crowded::Balanced {
                prop_assert!(c2.fee_bps <= c1.fee_bps.max(at as u16), "{c1:?} → {c2:?}");
            }
        }

        /// The side that is not crowded trades at X, to the atom.
        #[test]
        fn the_uncrowded_side_trades_at_x(
            x in 1_000_000_000_000_000u128..20_000_000_000_000_000_000u128,
            buys in proptest::collection::vec(1u128..10_000_000_000u128, 1..6),
            sells in proptest::collection::vec(1u128..10_000_000_000u128, 1..6),
            offers in proptest::collection::vec((0usize..LADDER, 1u64..20_000_000_000u64), 0..6),
        ) {
            let b: u128 = buys.iter().sum();
            let s: u128 = sells.iter().sum();
            let c = clear(x, b, s, &ladder(&offers)).unwrap();
            match c.crowded {
                Crowded::Buyers => for &q in &sells {
                    let (spent, got) = seller_leg(q, &c).unwrap();
                    prop_assert_eq!(spent, q);
                    let fair = mul_div_floor(q, x, WAD).unwrap();
                    prop_assert!(got <= fair && fair - got <= 1, "seller got {got}, fair {fair}");
                },
                Crowded::Sellers => for &q in &buys {
                    let (spent, got) = buyer_leg(q, &c).unwrap();
                    prop_assert_eq!(spent, q);
                    let fair = mul_div_floor(q, WAD, x).unwrap();
                    prop_assert!(got <= fair && fair - got <= 1, "buyer got {got}, fair {fair}");
                },
                Crowded::Balanced => {}
            }
        }

        /// The crowded side pays between X and X·(1 + f) per atom.
        #[test]
        fn the_crowded_side_pays_at_most_the_fee(
            x in 1_000_000_000_000_000u128..20_000_000_000_000_000_000u128,
            b in 1_000_000u128..10_000_000_000u128,
            s in 0u128..1_000_000_000u128,
            offers in proptest::collection::vec((0usize..LADDER, 1u64..20_000_000_000u64), 1..6),
        ) {
            let c = clear(x, b, s, &ladder(&offers)).unwrap();
            if c.crowded == Crowded::Buyers && c.buy_tokens > 0 {
                // effective price, WAD: spent / tokens
                let eff = mul_div_floor(c.buy_spent, WAD, c.buy_tokens).unwrap();
                let cap = mul_div_ceil(x, BPS + c.fee_bps as u128, BPS).unwrap();
                // one atom of rounding on the spent total
                let slack = mul_div_ceil(1, WAD, c.buy_tokens).unwrap();
                prop_assert!(eff <= cap + slack, "buyers paid {eff} per atom, cap {cap}");
            }
        }
    }
}
