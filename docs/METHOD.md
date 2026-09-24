# The bell price: method

What SESSION calls **the bell price** is Pyth's regular-session print at the bell, chosen by a written rule. It is not the exchange's official opening or closing auction price, and nothing here says it is until the calibration below has measured the gap. The rule is versioned: each print records the `method_version` it was taken under, and a print keeps that version for good.

This page describes **method v1**, the rule `programs/session-bell/src/rules.rs` implements. `docs/BELL.md` describes the program that enforces it.

## Method v1

**The close** is the *last* `Equity.US.<SYMBOL>/USD` price Pyth generated in `[close − 10 s, close]`. Close is 16:00:00 ET, or 13:00:00 ET on the three half-days: the day after Thanksgiving, and 3 July and Christmas Eve when each is a weekday and not itself the observed holiday. On 3 July 2026, a Friday, the market is closed outright for the Fourth.

**The open** is the *first* such price Pyth generated in `[open, open + 60 s]`, where open is 09:30:00 ET.

In either case the price must pass every check:

| Check | v1 | Why |
|---|---|---|
| Market session | `regular` | Pyth tags each price with the session its schedule puts it in. A pre- or post-market price is not a bell price however close to the bell it is. |
| Price | positive, exponent in [−18, 12] | A zero is Pyth's "no price", and a negative equity price is not a price. |
| Publishers | ≥ 1 | Pyth publishes an aggregate for a US equity only above its own per-feed minimum: 1 for SPY, AAPL and QQQ, 2 for NVDA and TSLA. A floor of 3 would refuse prices Pyth itself considers valid. The bells' own records will say what the count actually is at 09:30 and 16:00. |
| Confidence | ≤ 25 bp of the price | The quality guard that matters for a regular-session aggregate. The last sponsored NVDA update readable on chain (26 Aug 2026, mid-session) had 5.2 bp. |
| When | the feed's own update time, in the window | Since March 2026 a feed whose market has shut carries its last price forward in every message. A 16:00:05 message can hold a 15:59:58 price, and it counts as 15:59:58. |
| Consistency | the message is not older than its feed, and the feed is dated no more than 120 s past the chain's clock | A price cannot be from after the moment it is posted. |

**Replacement.** Anyone may post a candidate. A later close, or an earlier open, replaces the stored print. An equal or worse one is refused, so two posters holding the same aggregate cannot flip the account between their copies. Pyth cannot sign a price it has not produced, so the best candidate for a window exists only once the window has passed. With one honest poster before the deadline, the stored print is the rule's answer, whoever posted first.

**Deadline.** Posting closes 300 s after the window ends: 16:05:00 for a close, 09:36:00 for an open. From then on the print can be frozen (`Final`), or, if nothing qualified, the bell is recorded `Missing`. Neither changes again.

**What is kept beside it.** The listing's other feeds come from the same message and are stored with the print:

- the token-per-share redemption rate (`Crypto.<SYM>X/<SYM>.RR`);
- the token's own price (`Crypto.<SYM>X/USD`);
- the 24/7 index (`Equity.Index.<SYM>/USD`).

Their gap, `(token − equity × rr) / (equity × rr)`, is recorded in basis points, and a print is flagged when it exceeds 300 bp. None of them changes the bell price.

## Parameters and their bounds

Every parameter lives on the config account, and `set_params` refuses values outside these bounds. No setting turns the rule into a different oracle.

| Parameter | v1 | Bounds |
|---|---|---|
| `min_publishers` | 1 | 1–100 |
| `max_conf_bps` | 25 | 1–1,000 |
| `close_lead_secs` | 10 | 1–300 |
| `open_window_secs` | 60 | 1–900 |
| `finalize_after_secs` | 300 | 30–3,600 |
| `max_divergence_bps` | 300 | 1–10,000 |

A print is judged by the window and deadline it opened with. A parameter change never moves the goalposts for a print already open.

## Where v1 differs from the plan, and why

The plan of record (24 Sep 2026) sketched a rule that v1 narrows in three places:

- **Publishers.** The plan said 3. Pyth's own minimums (above) made that a rule that would refuse valid prices on three of the five listings.
- **A late open.** The plan kept searching up to 15 minutes after 09:30 when nothing arrived. v1 has one window. It is 60 s by default, and the admin can widen it to 15 minutes. A halted open is `Missing`, not a guess taken later.
- **Two calendars.** The plan derived the window from the program's calendar and Pyth's published schedule together. v1's on-chain window uses the program's calendar. The comparison with Pyth's schedule runs off chain (`tests/pyth-schedule.check.ts`: 2,114 listing-days, no disagreement). If the two ever disagree, the failure is safe by construction. A day the program thinks is open while Pyth's schedule says shut carries no `regular` prices, so its bells come out `Missing`.

## The devnet variant

Devnet runs v1 with two windows widened: the close takes the last price in 180 s and the open the first in 300 s. Its prices are Jupiter's reference price for each share, not Pyth Pro's, and Jupiter refreshes every one to two minutes. At v1's 10 s, nearly every simulated close would honestly be `Missing`. The widened windows are on the config account and on `/oracle`. The variant is not a method version of its own: it is a sandbox, and every print it records is flagged simulated.

## Calibration

v1's numbers are a starting point. They become a claim only after calibration against the exchanges' own prices, which needs real Pyth prints, and therefore a Pyth Pro key:

1. **Shadow-post** prints for 10 listings for 10 trading days, before any order settles on them.
2. **Compare** each print with the exchange's official open or close: the Nasdaq Official Closing Price, and the NYSE official open and close, used for research under each source's terms.
3. **Choose** the rule that minimises the median absolute error and its 95th percentile. The candidates are v1 as written, v1 with a different window, and a short median of signed updates (for example 09:30:00–09:31:00 at one-second spacing). Every candidate can be verified the same way. The winner becomes the next `method_version`.
4. **Publish** the error table on `/research` and keep it current. If the error is ever material, say so where the price is used.
5. **Language follows the data.** Until the error is shown to be negligible, the product says "the bell price (Pyth's regular-session print at the bell)", never "the official close".

The devnet sandbox calibrates nothing: its prices are not Pyth's.
