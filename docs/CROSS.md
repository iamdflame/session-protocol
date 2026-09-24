# The cross: orders that fill at the bell

`programs/session-cross` takes orders any time before a bell and fills all of them at one price, the bell's print from `session-bell` (`docs/BELL.md`). Buyers and sellers are netted against each other at that price, and the matched part pays no fee. If one side is larger, market makers fill the difference in a short uniform-price auction. Their fee is what that side pays, spread over the whole side.

This page is the specification. The arithmetic lives in `crates/session-core/src/cross.rs`, pure and property-tested, and the program only moves tokens according to it.

## What one token is worth

An xStock is a Token-2022 mint with the Scaled UI Amount extension. xStocks define one *displayed* token as one share-equivalent, with `displayed = raw × multiplier`. The multiplier grows as dividends are reinvested and jumps at a split, activating at 00:30 UTC the day after the ex-date. So one **raw** whole token is worth `multiplier` shares, and one raw atom is worth

```
X = share price × multiplier × 10^quote_decimals / 10^raw_decimals      (quote atoms per raw atom)
```

Three independent sources agree:

- xStocks' own documentation for integrators.
- Pyth's `Crypto.NVDAX/NVDA.RR` feed, which read 1.00091807 when NVDAx's multiplier was 1.0009180758, and `Crypto.SPYX/SPY.RR`, which reads 1.00571455 where SPYx's is 1.005715.
- Real Jupiter fills. From 24 Sep's $1,000 buys, a raw token cost 0–6 bp more than `share × multiplier`, which is the spread, and 22–57 bp more than one share, which is each multiplier.

The cross therefore prices from the **mint's own multiplier**, read from the mint account at the bell. The mint is on chain, not an oracle, and is the definition itself. The multiplier in force at time `t` is the scheduled one once `t ≥ new_multiplier_effective_timestamp`, else the current one: Token-2022's own rule. The f64 in the extension converts to WAD fixed point exactly from its bits, with no floating-point operation.

Two refusals protect the price:

- **A multiplier change near the bell.** If an activation falls within 15 minutes of the bell (xStocks ask venues to pause in that band), or the mint's multiplier configuration changed after the bell, the cross does not price. It is cancelled and everyone is refunded.
- **Disagreement with Pyth.** When the print carries Pyth's redemption rate, it must agree with the mint's multiplier to within 1 bp, or the cross is cancelled.

Open question: whether Pyth's `Crypto.<SYM>X/USD` quotes per displayed or per raw token. The cross does not use it.

## Orders

| | Buy | Sell |
|---|---|---|
| Escrows | quote atoms (USDC) to spend | raw atoms of the xStock |
| Limit (optional) | a maximum share price | a minimum share price |
| Fills | at the bell, never before | at the bell, never before |

A limit is on the share price, the number a trader knows: "buy at the close if NVDA is at most $230." An order whose limit the print breaks does not take part and is refunded in full. Orders can be placed and cancelled until the **freeze**, 120 s before the bell. After the freeze nothing enters or leaves the book, so nobody can react to a price they can see coming.

## The cross, step by step

```
Collecting ─(bell − freeze)─► Frozen ─(print final)─► Confirming ─(all confirmed)─► Auction ─(auction_secs)─► Settling ─► Done
                                    │
                                    └─(print missing, multiplier anomaly, or not priced within 6 h)─► Cancelled ─► refunds
```

1. **Collecting.** `place_order` escrows the order's funds with `transfer_checked`, and `cancel_order` returns them. The cross account is created by its first order.
2. **Pricing.** Once the bell's print is `Final`, anyone may call `price_cross`. It checks the print and the multiplier as above and records `X`. A `Missing` print, a multiplier anomaly, or no final print within 6 hours of the bell cancels the cross (`cancel_cross`, permissionless).
3. **Confirming.** `confirm_orders` walks the book in batches. Each order is checked against its limit and added to the side's in-band total, or marked out of band. The book is final when every order is confirmed.
4. **Auction.** The crowded side and the imbalance are now known. For `auction_secs` (120), anyone may post a **firm** offer on the needed side at a fee from 0 to `max_fee_bps` (at most 100). A token offer serves crowded buyers; a quote offer serves crowded sellers.
5. **Clearing.** `clear` runs once, after the auction. Offers are banded by fee, one bucket per basis point. The clearing fee `f` is the lowest *ask* at which the offers asking at most `f` cover the imbalance. It is always a fee somebody asked: a fee that climbed until the same offers sufficed would charge the crowded side for nothing. The cheapest offers fill first, the marginal band pro rata, and the rest not at all. Every filling maker gets the same price: a uniform-price auction, deterministic, with no sorting on chain.
6. **Settling.** `settle` is permissionless and batched. Each order and offer has a token leg and a quote leg, settled independently. An issuer pause of the xStock can delay token legs; it can never block a quote refund.

## The arithmetic

Let `B` be the in-band buyers' quote, `S` the in-band sellers' raw atoms, and `X` the price per raw atom.

**Buyers crowded** (`B > S·X`). Every seller fills in full at `X`. The buyers' remaining quote `R = B − S·X` buys from makers at `X·(1 + f)`.

- **Enough offers.** `f` is the lowest fee with `capacity(≤ f) ≥ R / (X·(1+f))`. The makers supply `A = ⌊R / (X·(1+f))⌋` raw atoms, and buyers receive `S + A` in total.
- **Too few offers.** Every offer fills at the highest fee posted, and buyers are filled pro rata.

**Sellers crowded** (`S·X > B`). Every buyer fills in full at `X`. The sellers' remaining tokens go to makers who pay `X·(1 − f)`, found the same way. Sellers receive `B` plus what the makers pay, pro rata.

**Balanced.** Both sides fill at `X` and nobody pays a fee.

A crowded buyer's effective price is therefore `X · (1 + f · A/(S + A))`: the fee applies only to the part makers supplied, spread over everyone on that side. The matched part is exactly `X`.

**Rounding favours escrow, always:**

- Whatever an order *gives up* is rounded up, and whatever it *receives* is rounded down. No order gives up more than it escrowed.
- Each total an order is paid from is computed once, at clearing, and is at least the sum of the rounded-down shares drawn from it.
- A maker in the marginal band gives up its share rounded up and is paid for it rounded down: at most one atom of the other token, its own rounding cost.
- For every cross and each mint, `paid out + refunded ≤ escrowed`. The program asserts it on every settlement. Dust stays in escrow and goes to the treasury when the cross closes.

`crates/session-core/src/cross.rs` holds these as pure functions. Property tests assert, over 10,000 randomised crosses each:

- conservation, with the dust bounded;
- no order gives up more than it escrowed;
- the uncrowded side trades at exactly `X`;
- the crowded side pays at most `X·(1+f)`;
- more capacity never raises the fee.

The fee rule above came out of that last property. The TypeScript mirror is pinned to the Rust by vectors.

## Invariants

- Nothing leaves escrow except to the order's owner, or to its counterparty under the clearing result.
- The price is exogenous, and the book is frozen before the bell, so nobody can front-run the cross.
- A final print is immutable, and a cross prices at most once.
- Refunds are always reachable: a cancelled cross refunds everyone, and the admin can only stop *new* orders.
- A non-zero transfer fee, a transfer hook or a paused mint stops new orders. xStocks carry none of the first two.
