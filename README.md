# SESSION

**Wall Street is shut for 17.5 hours a day. Nobody has ever been able to own
those hours separately.**

A tokenized share trades around the clock, but the stock behind it trades for
6.5 hours. During those hours an arbitrageur can hedge the token against the
real share and the two stay pinned together. Outside them nobody can, and the
token is free to drift.

Those are two different assets wearing one ticker. SESSION separates them into
`X.NIGHT` and `X.DAY`.

Built for [STOCKLANA](https://hackathons.solana.com/hackathons/stocklana).

---

## What we set out to test, and what we found

The overnight effect is the most durable anomaly in equities. The US equity risk
premium accrues almost entirely between the close and the next open; intraday
returns are roughly zero. Cooper, Cliff and Gulen documented it in 2008 and it
has held for seventeen years across NYSE and Nasdaq. In IWM, a dollar held only
overnight grew to $3.72 while a dollar held only intraday fell to $0.66.

Nobody harvests it. Capturing the overnight stream means a full round trip
roughly 250 times a year, and the spread grinds the edge to nothing.

Tokenized equity makes that window continuously tradeable for the first time.
So: **does the anomaly survive when the night becomes tradeable?** Nobody had
measured it, because until these tokens existed there was nothing to measure.

We measured it. 83,322 hourly closes, 26 tokenized assets, ~220 days of real
Solana pool history.

```
NIGHT minus DAY, per hour of exposure, paired across 20 US equities
  mean difference   −1.16bp        t = −1.11
  NIGHT wins        9/20 assets
```

**There is no session premium in tokenized equities.**

The most economical reading is that the overnight premium was never a reward for
bearing overnight risk. It was a reward for being unable to trade. Remove the
constraint and it goes away.

`GLDx` is the control the mechanism predicts, and it behaves: gold trades ~24h
globally, has no closed session to arbitrage around, and shows nothing either
way (night t = −0.30, day t = −1.20).

### The sharper result is about risk, not return

The return comparison is only half the question. The night pays no more than the
day — while carrying materially more risk:

```
mean session volatility    NIGHT 2.77%     DAY 1.97%     the night is 41% more volatile
fatter left tail           NIGHT in 16/20 assets
```

**The night is uncompensated risk.** And that asymmetry is structural rather than
a quirk of the sample: a DAY holder is only exposed while the market is open, so
they can always trade out before a gap. A NIGHT holder cannot. They wear every
gap in full, by construction.

Which gives the two tokens an honest job:

| | what it is |
|---|---|
| **`X.DAY`** | equity exposure **you can always exit**. No overnight gaps — you are never holding while the market is shut. |
| **`X.NIGHT`** | the gap risk, **isolated**, for whoever wants to be paid to carry it. |

Nobody can buy either of those today. Holding a share means holding both, always,
whether or not you want the night. SESSION is the market that separates them, and
the funding rate between the classes is the price of the transfer.

Reproduce it:

```bash
node research/fetch-hourly.mjs                                  # ~40 min, rate-limited
node --experimental-strip-types research/session-study.ts       # the verdict above
```

## The protocol

A vault holding one xStock issues two SPL tokens. Exactly one holds the stock at
any moment; the other holds quote.

| | earns |
|---|---|
| `X.NIGHT` | the return while the US market is **closed** — nights, weekends, holidays |
| `X.DAY` | the return during the **NYSE regular session** |

### Why this is possible here and not in a brokerage

At every boundary, a day-holder wants to be flat at precisely the instant a
night-holder wants to be long. **They are perfect counterparties.** Pair them in
one vault and the inventory changes owner at the oracle mark without touching a
market.

Only the *difference in size* between the two sides ever has to trade:

```
delta = value(newly exposed class) − value(previously exposed class)
delta == 0  →  nothing trades at all
```

That is the whole unlock. The round trip that makes this strategy impossible in
a brokerage account becomes a bookkeeping entry. Measured against live Jupiter
routes, the residual costs a median **21bp round trip at $10k** — and a balanced
book pays none of it, because the handoff never leaves the vault.

### Funding: the price of transferring gap risk

When the classes are not the same size, the vault does have to trade the
difference, and the crowded side is what caused that cost. So the crowded side
pays the sparse side, exactly as a perpetual pays to hold its mark to the index.

The resulting rate is the market's answer to *"what is a night worth?"* — which,
given the measurement above, is really *"what should someone be paid to carry
gap risk?"* Nobody has been able to quote that number, because nobody could hold
either side of it on its own.

### Mint and redeem

**A class may only be minted or redeemed while it is parked in quote.** Mint
NIGHT during the day; mint DAY at night. A parked class holds only quote, so
issuance moves quote in or out and never has to buy or sell stock — primary
issuance has no market impact by construction. It is the discipline an ETF uses:
authorised participants create at NAV, everyone else trades the secondary market.

## Pyth does three separate jobs

The protocol cannot function without any of them.

| feed | job |
|---|---|
| `Crypto.<SYM>X/USD` | the mark for NAV — the vault holds the **token**, not the stock |
| `Equity.US.<SYM>/USD` | **session detector.** It only publishes while the real market is open, so its staleness *is* the closing bell |
| `Crypto.<SYM>X/<SYM>.RR` | the token-to-stock ratio — the basis itself, published directly |

The second is the interesting one. The vault does not trust its own calendar
alone: if the calendar says "open" but the US equity feed has gone quiet, the
market is treated as **shut**. An unencoded holiday or a trading halt degrades
safely. The calendar can only be wrong in the safe direction.

Every mark is gated on Pyth's confidence interval before it is allowed to move
anyone's NAV. Pyth is the only major oracle that publishes its own uncertainty,
and refusing to settle when it is high is the entire reason to want that number.

## Correctness

The accounting decides who gets paid, so it is written twice and pinned together.

- **4,734 calendar vectors** — Rust and TypeScript agree on every one. Integer
  date arithmetic only, no timezone database: a tz database that updates
  underneath a deployed program is an unreviewed change to who gets paid.
  Reproduces the real 2026 NYSE calendar including July 3 observed (July 4 falls
  on a Saturday), both early closes, Good Friday via computus, and both DST
  transitions.
- **1,608 settlement vectors** — Rust and the SDK agree exactly on NAVs, funding
  transfers and handoff deltas, across empty classes, maximally lopsided books,
  and funding on and off.
- **Property tests** on conservation, funding being zero-sum, and exposure always
  flipping. These earned their place: one caught settlement round-tripping NAV
  through value, which quantised NAV to the value's resolution and floored it —
  leaking from holders at *every* boundary, one-directionally.
- **Replay** — months of real hourly closes pushed through the same `settle()` the
  chain runs, boundary by boundary. Fixed-point NAV tracks a floating-point
  reference to four decimals across ~300 boundaries per asset.
- **256-bit `mul_div`** — the naive `u128` path overflows on ordinary NAV × price
  inputs.

```bash
cargo test -p session          # 46 unit + property tests, plus the replay
```

## Layout

```
programs/session/src/
  calendar.rs    NYSE session oracle — DST, holidays, half-days, computus
  fixed.rs       256-bit mul_div, WAD fixed point
  settle.rs      boundary settlement, NAV roll, handoff sizing
  funding.rs     skew-based funding between the classes
  oracle.rs      Pyth marks, guards, and an explicit PriceUpdateV2 parser
  state.rs       vault accounts and events
  lib.rs         instruction surface
keeper/          the permissionless boundary crank
sdk/             calendar + settlement mirrored in TypeScript
research/        the session study, and live execution costs
tests/vectors/   the cross-language vectors
```

### On the Pyth SDK

`pyth-solana-receiver-sdk` is deliberately not a dependency. Its current release
pins `anchor-lang` 1.2.0 against this program's 0.31, and the last release that
accepts 0.31 no longer compiles on current Rust. Pinning a path that decides who
gets paid to a dependency's release schedule is worse than owning ~90 lines of
documented layout.

The account owner is checked against the Pyth receiver program and the feed id
against the vault's configuration; neither is optional. Parsing is sequential
rather than fixed-offset because `verification_level` is a borsh enum and
therefore variable width — a fixed-offset reader silently misreads every
`Partial` update.

## Honest limits

- **~220 days, one venue, one regime.** The verdict above is a measurement, not a
  proof. It says the premium is not detectable here; it does not say it can never
  appear.
- **Hourly closes.** The 16:00 ET close lands on the hour and is clean; the 09:30
  open does not, so the 09:00–10:00 interval straddles a boundary. Strict
  attribution drops it, which removes the first 30 minutes of every DAY session.
- **Neither class is levered.** Each is a claim on one session's returns, not a
  short of the other.
- **Not deployed to mainnet.** xStocks exist only on mainnet, so integration
  against live mints needs a forked validator. The math, the calendar and the
  settlement path are tested; the deploy is not.
- **No frontend yet**, by design — this is the system.
- Research tool. Not investment advice.
