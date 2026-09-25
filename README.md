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

**Live:** [session-roan.vercel.app](https://session-roan.vercel.app)

| | |
|---|---|
| Program, devnet | [`8gWC37…KqKZ`](https://explorer.solana.com/address/8gWC37AFvgnPMAZSqiimbkpqPVhF3PrA1rao5agVKqKZ?cluster=devnet) |
| Equity vault — NYSE hours | [`DqdXeM…oBti`](https://explorer.solana.com/address/DqdXeMbPHiDMMrVPeiGDBCNtDAxtMZNtEtTLN4eYoBti?cluster=devnet) · [`/markets/NVDAx`](https://session-roan.vercel.app/markets/NVDAx) |
| Event vault — no exchange session | [`FtpWQU…SGDDC`](https://explorer.solana.com/address/FtpWQUy4ZAoyBDS4zbwsLLc92qppciEgcCgCavVSGDDC?cluster=devnet) · [`/markets/OPENAI`](https://session-roan.vercel.app/markets/OPENAI) |
| `NVDA.DAY/quote` pool, Meteora DAMM v2 | [`8Vm6ei…XiybN`](https://explorer.solana.com/address/8Vm6ei7cgBacHdxbsLYEoXdZo5zCPzqBN1YgpVKXiybN?cluster=devnet) |
| `$BELL`, **mainnet**, quoted in real NVDAx | [`7z9y4P…PdQTe`](https://solscan.io/token/7z9y4P3yatZki2AHHtzjPxEhjVTP1d362BQH1kDPdQTe) · [`/bell`](https://session-roan.vercel.app/bell) |
| Protocol account — the curator, and nothing else | [`8Ax4HJ…6RbC`](https://explorer.solana.com/address/8Ax4HJxoh3VWVb7fp4zVkXtSfY4bueXqYxjJWuEY6RbC?cluster=devnet) · [`/markets`](https://session-roan.vercel.app/markets) |
| Open one yourself — no permission required | [`/list`](https://session-roan.vercel.app/list) |

Ninety seconds, in the order that lets you check it: **[docs/JUDGE.md](docs/JUDGE.md)**.
What we entered and what we refused: **[docs/BOUNTIES.md](docs/BOUNTIES.md)**.
Who holds the keys and what they can do: **[docs/UPGRADE-POLICY.md](docs/UPGRADE-POLICY.md)**.
What mainnet costs, and why it has not happened: **[docs/PHASE-F.md](docs/PHASE-F.md)**.

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

We measured it. 83,322 hourly closes, 26 tokenized assets, 235 days of real
Solana pool history — after rejecting 38 single-bar prints that reverse within
the hour, one of which had put a permanent 12% cliff into a curve because its
recovery landed exactly on the closing bell (`docs/AUDIT.md` §14).

```
NIGHT minus DAY, per hour of exposure, paired across 20 US equities
  mean difference   −1.37bp        t = −1.31
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
mean session volatility    NIGHT 2.78%     DAY 1.90%     the night is 46% more volatile
fatter left tail           NIGHT in 18/20 assets
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
npm run study                                                   # the verdict above
```

Or read it on the site: [/research](https://session-roan.vercel.app/research)
carries every asset, every t-statistic, the controls and the method — including
what disagrees.

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

## The bell oracle

The next product settles orders at the open and the close, so it needs the
open and the close on chain. `programs/session-bell` keeps them: for each
listing and trading day, one print for 09:30 and one for 16:00, taken from a
Pyth Pro message whose signature a Pyth verifier checked in the same
transaction and which a written rule accepted (`docs/METHOD.md`). Anyone may
post, and a better price replaces the stored one until the deadline. After
that the print is final, or the bell is recorded missing.

It is held to Pyth's own code from both ends. Its parser reads every
message Pyth's own encoder wrote for it and refuses each broken variant with
the named error, and its end-to-end tests run against Pyth's verifier exactly
as deployed on mainnet (`tests/integration`, in LiteSVM). It is live on
devnet for NVDA, SPY, TSLA, AAPL and QQQ, with a poster running every bell,
and the site's `/oracle` page shows every print. On devnet the signer is a
test key and the prices are Jupiter's, because there is no Pyth Pro key yet.
The program flags every such print `simulated`, for good, and the page says
so first. The details, the byte-exact verification path and how to check a
print yourself are in [`docs/BELL.md`](docs/BELL.md).

## Bell orders: the cross

The oracle exists for this. `programs/session-cross` takes orders any time
before a bell and fills all of them at the bell's print, times the xStock
mint's own multiplier. A raw xStock token is `multiplier` shares; xStocks'
docs, Pyth's `.RR` feeds and real Jupiter fills agree (`docs/CROSS.md`).

- Buyers and sellers net against each other at that price, and the matched
  part pays no fee.
- If one side is larger, makers fill the difference in a two-minute
  uniform-price auction. Their fee is shared across the crowded side, and a
  backstop maker's standing offer caps it.
- The book freezes two minutes before the bell, so nobody can react to a
  price they can see coming.
- A missing print, a multiplier change near the bell, or Pyth disagreeing
  with the mint cancels the cross and refunds everyone whole.
- An issuer pause can hold tokens, never a quote refund.

The arithmetic is `crates/session-core/src/cross.rs`, property-tested over
10,000 random crosses per property, and the fee rule came out of those
tests. The program is tested end to end on the real NVDAx mint with
Pyth-verified prints, and every balance matches the arithmetic to the
atom. Its devnet deployment is pending: it needs 3.39 SOL of program rent.

## Safety model

Every caller is assumed adversarial and every input hostile.

- **Balances are tracked, never read.** Anyone can transfer into the vault's
  token accounts. A vault deriving its position from `token_account.amount`
  would absorb those transfers into its accounting and hand an attacker a lever
  on settlement. The excess is surplus: skimmable, never spendable.
- **Solvency is asserted, not assumed.** Every value-moving instruction ends by
  proving assets still cover claims.
- **The session is tracked, never inferred.** Inferring it from `session_at(now)`
  cannot distinguish zero elapsed boundaries from two — and the difference is an
  entire session's return paid to the wrong class.
- **Ambiguity halts.** When the vault cannot know who is owed what — a missed
  boundary, an unfilled handoff, a loss larger than the exposed class — it stops
  and waits for an operator rather than guessing. A halt is the protocol working.
- **Rounding always favours the vault.** Depositors receive `floor(shares)`,
  redeemers `floor(quote)`, gains floor and losses ceil, fees round against the
  payer. Dust accumulates as backing rather than leaking out of it.

`docs/AUDIT.md` records what was wrong before this was true, including three
silent insolvency paths that only a long randomised simulation exposed.

## Correctness

The accounting decides who gets paid, so it is written twice and pinned together.

- **4,734 calendar vectors** — Rust and TypeScript agree on every one. Integer
  date arithmetic only, no timezone database: a tz database that updates
  underneath a deployed program is an unreviewed change to who gets paid.
  Reproduces the real 2026 NYSE calendar including July 3 observed (July 4 falls
  on a Saturday), both early closes, Good Friday via computus, and both DST
  transitions.
- **1,608 settlement vectors** — Rust and the SDK agree exactly on NAVs, funding,
  handoff deltas and bad-debt shortfalls.
- **A pinned account layout** — the program emits a serialized `Vault` and the
  SDK decoder is tested against those exact bytes. Layout drift is otherwise
  invisible: the client reads a field at the wrong offset, reports a plausible
  number, and an operator acts on it.
- **Property tests** on solvency preservation across mint, redeem and fill; that
  a mint-then-redeem round trip can never profit; that a fill never overshoots
  zero; that the Pyth parser never panics on arbitrary bytes; that boundaries
  always alternate; that counting boundaries matches walking them.
- **40 randomised year-long simulations**, checking solvency after *every* mint,
  redeem, fill and settlement. This found three rounding-direction bugs that all
  passed the unit tests, because each loses one atom per operation and an atom
  looks like nothing.
- **Replay** — months of real hourly closes through the same `settle()` the chain
  runs. Fixed-point NAV tracks a floating-point reference to four decimals across
  ~300 boundaries per asset.
- **256-bit `mul_div`** — the naive `u128` path overflows on ordinary NAV × price.

```bash
npm install       # once, at the root — a workspace; it installs the site too
npm test          # eligibility, 156 Rust tests, 8 TypeScript suites
npm run vectors   # regenerate the cross-language vectors
```

The site has its own chain: `cd web && npm run verify` type-checks it against
the SDK, regenerates the pre-paint session script and refuses if it disagrees
with the calendar across 313,117 timestamps, drives mint/redeem in a headless
browser (local vault, then the devnet vault through an injected wallet), places
and cancels bell orders on devnet through `/bells`, checking each against the
chain to the atom, walks the local vault across boundaries, and audits every
page for names, headings, keyboard reach and computed contrast on both grounds.

Operator procedures, health thresholds and a recovery path per halt reason are
in `docs/OPERATIONS.md`.

## The site

[session-roan.vercel.app](https://session-roan.vercel.app). The session is the
interface: which class is active, when the next bell rings and which class is
open to mint are on every page, drawn from the same calendar module the program
settles on. DAY is blue and NIGHT amber wherever they appear, and every figure
says where it came from — **Live** for the chain, **Devnet** for test funds,
**Simulated** for the in-browser vaults, **Demo** for the sandbox.

- **Home** — the product first: which class holds NVDA right now, the countdown
  to the handoff, a draggable 24-hour rail, NVDA.DAY and NVDA.NIGHT with their
  on-chain NAVs, and a mint button that names the class it can actually issue.
- **Trade / NVDAx** (`/trade`, `/markets/NVDAx`) — the real vault on devnet:
  connect a wallet, get test quote from the faucet, mint or redeem the parked
  class with a five-stage transaction flow, see what you are exposed to over the
  last three days of sessions, and your position with what the next bell does to
  it (the program's `settle()` run at the live mark). Oracle, settlement,
  instrument, full ledger and every account are in a Protocol details drawer.
- **Demo** (`/trade?demo=1`) — a sandbox copy of the NVDAx vault, seeded from
  devnet: mint, set where the mark is, ring the bell and watch exposure and
  funding move. Nothing is signed or sent, and it says so on every surface.
- **Portfolio** — every position the connected wallet holds, valued at NAV, with
  P&L from its own trades and a before/after of the next bell.
- **Markets** — all 26 assets with live Jupiter prices and both class returns,
  and the vaults that exist, found by scanning the program. OPENAI runs the same
  program on an asset with no exchange session; the other 24 run the settlement
  code locally, labelled Simulated.
- **Research** — the question, the four numbers that bound it, the finding and
  the risk as figures, DAY against NIGHT for every asset, and the method,
  controls, stress test and limitations a click away.
- **How it works** — the mechanism as seven steps you can play, the calendar,
  what is live and what is not, and the failure modes.
- **Bell** — the next bell as the protocol's heartbeat, whether the vault has
  settled it, and the keeper: `$BELL` on mainnet and what it cannot do.
- **Oracle** — every open and close the bell oracle has recorded, the rule
  as the config holds it, and what on devnet is simulated and what is not.
- **List** — open a vault yourself; `initialize_vault` takes no permission.

A 90-second tour walks the seven things worth seeing. No chart library, no UI
kit. The DAY/NIGHT pair is validated for colour-vision deficiency (ΔE 27.6
between the marks under simulation, 31.1 in normal vision), and the
accessibility harness finds no problems on any route with either session active.

## Layout

```
crates/session-core/src/     shared by every program, no dependencies
  calendar.rs    NYSE session oracle — DST, holidays, half-days, computus
  fixed.rs       256-bit mul_div, WAD fixed point
programs/session/src/
  settle.rs      boundary settlement, NAV roll, handoff sizing
  funding.rs     skew-based funding between the classes
  oracle.rs      Pyth marks, guards, and an explicit PriceUpdateV2 parser
  state.rs       vault accounts and events
  lib.rs         instruction surface
  machine.rs     the session state machine — tracked, never inferred
  ops.rs         instruction policy, separated from plumbing so it is testable
programs/session-bell/src/   the bell oracle
  lazer.rs       Pyth Pro messages, parsed exactly or refused
  rules.rs       method v1: which price is the open or the close
  state.rs       config, listings, prints
  lib.rs         post, finalise, mark missing; the verifier CPI
sdk/             calendar, settlement, account decoding, health, instruction builders; bell.ts
keeper/          the permissionless crank and fill; devnet init and checks; the bell poster
programs/session-cross/src/  bell orders: escrow, pricing, the auction, settlement
crates/session-core/src/xstock.rs  what a raw xStock atom is worth, read from the mint
crates/session-core/src/cross.rs   netting and the uniform-price auction, pure
tests/integration/  LiteSVM against Pyth's own verifier binary; the cross on the real NVDAx
tools/lazer-devnet/ Pyth's verifier under a devnet id, for the test signer
web/             the site — Vite + React, the wallet layer, two serverless functions
research/        the session study, bad-print rejection, live execution costs
docs/            the audit, the runbook, the key policy, the mainnet costing; the bell and the cross (BELL.md, METHOD.md, CROSS.md)
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
- **Devnet, with stand-ins.** Devnet has no xStocks, no USDC and no sponsored
  feed for any tokenised equity, so the live vault uses test mints and takes its
  mark from Pyth's `Crypto.SOL/USD`. The program, the classes, settlement,
  funding, the handoff and the health signals are the mainnet program doing the
  mainnet thing; the site says which parts stand in, above the fold.
- **The mark for a settlement must come from the bell's own window.** A crank
  landing an hour late reading the live feed has a number that is fresh and
  wrong; the keeper posts the print Pyth published *at* the bell instead.
- **A missed bell is replayed, not written off.** `recap` walks the calendar
  and applies each one through the same `settle()` the live path runs. There
  is no path that resumes with sessions unpaid.
- **A 20% gap settles.** Refusing it would leave a vault unable to settle at
  all on exactly the night the NIGHT class exists for. Fills pause; only a
  shortfall halts.
- **The residual clears in a call auction** at one price for everyone, and one
  has now run on devnet: the 21 Sep closing bell left a $7,528 residual, the
  auction opened on it, took a single bid for all 63.59 of the underlying it
  wanted, and cleared at the bell's own mark of 1.183837 with the bid account
  closed and its rent returned. `npm run devnet:auction` is that sequence. The
  arithmetic is property-tested over arbitrary bid sets.
- **An event session** carries names with no exchange behind them. `OPENAI`
  has no 09:30, so its vault has no clock: the boundary is the next print or
  a premium divergence, read live from prestocks.com. That detector is the
  one place the protocol rests on somebody's word, and the page says so.
- **The share classes carry their own names on chain** — `NVDA.DAY`,
  `NVDA.NIGHT` — as Token-2022 mints with metadata.
- **The live vault holds a Token-2022 underlying.** Real xStocks are Token-2022
  with extensions, and USDC is not, so the program takes two token programs and
  the devnet vault is shaped like the real pair: a Token-2022 underlying with a
  permanent delegate, a classic-SPL quote. A browser wallet has minted and
  redeemed against it on devnet. `npm run test:validator` goes further and runs
  the program against the *actual* mainnet NVDAx and USDC accounts on a local
  validator; it needs a CPU with AVX2, which this machine does not have, so it
  reports SKIPPED here and is the reason `.github/workflows/ci.yml` exists.
  That workflow has never run: the account's Actions are locked for billing
  and every push fails in four seconds without starting a job. So the test
  against the real mainnet accounts has not been executed anywhere, and this
  says so rather than pointing at a green badge that does not exist.
- **Holding a real xStock needed a second fix, deeper than the first.** Anchor
  sizes a token account by enumerating the mint's extensions, and that call
  refuses any extension the pinned `spl-token-2022` predates — which NVDAx and
  OPENAI both carry two of. The length now comes from the chain itself, via
  `GetAccountDataSize`. The story is in [docs/JUDGE.md](docs/JUDGE.md), because
  a project arguing for honesty about what is deployed should be plain about
  what was broken.
- **The issuer holds powers no program can take away.** NVDAx carries a
  permanent delegate, a pause switch and a freeze authority. A vault holding it
  can be emptied, paused or frozen by the issuer. That is true of holding the
  token at all; it is stated here because a vault makes it easy to forget.
- **Mainnet** needs a Hermes key to post the xStock feeds (the public sponsored
  ones are weeks stale on both clusters), ~3 SOL, and the local-validator
  initialisation in the runbook. `Anchor.toml` lists the accounts to clone.
- **Funding parameters are unproven.** They are reasoned defaults, not calibrated
  ones. There is no live market to calibrate against — which is what the protocol
  exists to create.
- **`cargo update` breaks the SBF build.** Seven host-side crates are pinned
  below edition 2024 in `Cargo.lock`; the runbook explains.
- Research tool. Not investment advice.
