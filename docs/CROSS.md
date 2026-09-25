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

## Where it stands

**Built and tested.** `programs/session-cross` (`Crosf1CpgcEs6G6SiX2B7KMR4hxVcE2FGU2r53a3RK9K`), 667,656 bytes. Its instructions:

- `init_config`: bound to the upgrade authority.
- `create_market` and `set_market`: admin; bounded parameters and the new-order switch.
- `place_order` and `cancel_order`: until the freeze.
- `price_cross`: once the print is final, or it cancels.
- `cancel_cross`: no final print within six hours.
- `confirm_orders`: batched.
- `post_offer`: during the auction.
- `clear`: after it.
- `settle_order` and `settle_offer`: per leg.
- `close_cross`: dust to the treasury, rent back.

Every step after `place_order` is permissionless.

`tests/integration/tests/cross.rs` runs it in LiteSVM on the **real NVDAx mint**, captured from mainnet and installed at its real address with only its authorities swapped. Prices come from prints **Pyth's own verifier** checked. All 9 cases pass, and every balance change equals `session_core::cross` computed from the same book, to the atom:

- **A full cross.** Five orders net at $224.06 × 1.0017, and two limit orders are refunded whole. A 15 bp maker fills 4.676 NVDAx at the uniform price, and a 40 bp maker is not needed. The seller receives exactly `X`: $448.882340 for 2 raw tokens. The dust (1 raw atom, 3 quote atoms) goes to the treasury, and escrow ends at zero.
- **Crowded sellers** against a quote maker at 20 bp.
- **A missing print** cancels the cross and refunds everyone whole; so does **no print within six hours**.
- **The freeze** holds at 120 s before the bell; a cancel before it returns the escrow.
- **Only the owner** cancels an order; there is no order without a bell, and minimums hold.
- **An issuer pause** mid-settlement holds the tokens but never the quote refund, and a paused mint takes no new orders.
- **A multiplier activation** 60 s before the bell cancels the cross.
- **Pyth's `.RR`** disagreeing with the mint's multiplier cancels the cross.

`tests/integration/tests/cross_fuzz.rs` then runs randomised crosses through the program, one per trading day. Each has:

- a random share price;
- 1–5 buyers and 1–5 sellers, with random sizes and random limits, some out of band;
- 0–3 makers at random fees on whichever side is crowded.

Every participant's balance change must equal the arithmetic to the atom, and the escrow must be empty after every close. 300 crosses pass on one seed (181 crowded with buyers, 119 with sellers, 12,845 NVDAx delivered), spanning more than a year of trading days: DST changes, holidays and a year boundary. 40 pass on the default seed on every run. `CROSS_FUZZ=<n> CROSS_FUZZ_SEED=<s>` runs more.

**On devnet since 25 Sep 2026.** `npm run cross:devnet -- --apply` stood the sandbox up (`web/public/cross-devnet.json`):

- a fixture NVDAx, `FFMzfSf2…`, a Token-2022 mint carrying NVDAx's own multiplier bits and the real one's extensions;
- the config;
- the NVDA market, `AYmob34F…`, priced by the devnet bell's simulated prints;
- the backstop maker, `7oc1Nj6Z…`, offering at 15 bp.

The keeper runs as a systemd user service (`deploy/install-service.sh cross-keeper`) and takes every cross from bell to close. `npm run cross:demo` seeds the next bells with the team's own labelled test orders.
It keeps a paid-out cross for a day before closing it, so the site can show the bell's result.

**On the site.** `/bells` is the ticket and the book: pick a bell, a side, an amount and an optional limit, and cancel until the freeze. `web/scripts/bells-flow.mjs` drives it with an injected devnet wallet and checks every order against the chain to the atom.

## The receipt, and the swap beside it

Every cross has a receipt at `/b/<cross>`, read from the chain on each visit:

- **The price** the cross cleared at, and what one raw token was worth at the multiplier the cross recorded.
- **The print.** The page fetches the transaction that posted it and checks its Ed25519 signature again, in the browser, over the bytes the program parsed. It then compares the signed feed with what the print stored, field by field, and confirms that the transaction opens with the Ed25519 precompile, as the verifier requires.
- **The cross**, step by step: frozen, priced, auction, cleared, settled. It shows both sides' totals, what each side got and its fill ratio, the crowded side and its fee, and the escrow in and out.
- **Your orders in it**, when this browser placed any.
- **Every transaction** that touched it.

**The counterfactual.** A receipt that claims a saving without the alternative beside it is an advertisement. So at the bell, the keeper quotes each side's total on Jupiter, for the real NVDAx on mainnet: the buyers' USDC in, the sellers' raw tokens in. The fixture has the real mint's decimals and multiplier, so the atoms carry over unchanged.

The quotes go into a Memo instruction of the `price_cross` transaction itself, as `session-cross counterfactual v1 {json}` (`sdk/src/counterfactual.ts`). That makes them timestamped by the chain, signed by the keeper, and visible on any explorer.

The receipt compares rates, not totals, because limits can leave part of a side unfilled: per dollar for buyers, per token for sellers. It shows the result in basis points to two places.

Anyone can put a memo in a transaction that touches a cross, so a receipt shows a counterfactual only when two things hold:

- the memo is in the transaction that priced this cross;
- the keeper that the market's manifest names (`keeper`) signed that transaction.

With no counterfactual, the receipt says it makes no claim about savings.

The Memo program charges by the byte: 124k compute units for a real counterfactual on devnet, and 222k for the largest one the reader accepts. The keeper therefore sets a 600k limit on that transaction, rather than share the default with the price. On devnet the cross is a rehearsal at a simulated print while the swap is a real mainnet quote, and the receipt says so where the two meet.

## From a post: the Blink

`/api/bell-action` is a Solana Action (`web/api-src/bell-action.ts`).

- **GET** returns the card: buy or sell NVDAx at the next bell, when it fills, when it freezes, the fee cap, and that this is devnet.
- **POST** `{ account }` returns the `place_order` transaction, built at that moment for that wallet. It is the same instruction `/bells` builds, with a fresh nonce.

Before handing over anything to sign, the function reads the balance the order would draw on. A wallet that cannot pay is told how much it holds and where the faucet is, instead of being given a transaction that fails.

Orders through the Blink are capped at $1,000 or 5 NVDAx, because the sandbox's backstop is finite. The function holds no key. `actions.json` maps `/bells` to the action, so a shared link to the page unfurls as a Blink. `npm run actions` drives it as a client would, through to a real order on devnet that it then cancels.

## Issuer-power drills, on devnet

An xStock's issuer can pause its mint and change its multiplier, so the cross has to survive both without anyone losing an atom. `tests/integration/tests/cross.rs` proves this in LiteSVM on the real NVDAx bytes. `keeper/src/cross-drill.ts` runs the same two cases in public, at a real bell. Each has a fixture mint of its own and a market on the NVDA listing, so the demo market is untouched. The same keeper cranks them, from `web/public/cross-drills.json`.

- **Pause.** Alice buys $40 and Bob sells 0.2 NVDAx, then the issuer pauses the mint. The cross prices and clears, because neither step moves a token. Settling the tokens fails, so the keeper pays each quote leg alone and the tokens wait in escrow. The drill then resumes the mint, the tokens follow, and the keeper closes the cross ten minutes after it clears. It passes only if both of the market's escrow accounts then read zero.
- **Multiplier.** Alice buys $30 and Bob sells 0.1 NVDAx, then the issuer schedules multiplier 1.0025 for five minutes after the bell. That falls inside the pricing guard, so `price_cross` cancels the cross instead of guessing which multiplier the bell meant, and the keeper refunds everyone whole. It passes only if the refunds equal what went in and both escrows read zero.

`npm run cross:drill -- --watch` does the issuer's part at the right moment and writes each step's transaction into `cross-drills.json`: it resumes the mint only once every quote leg is paid while the tokens are still held. `--status` prints the record. The first runs are armed for the 25 Sep open.
