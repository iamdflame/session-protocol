# Ninety seconds

The claim, the evidence, and the parts that are not real yet — in the order
that lets you check them rather than believe them.

---

## The claim

A tokenized share trades twenty-four hours. The stock behind it trades for
six and a half. During those hours an arbitrageur can hedge the token against
the real share and the two stay pinned; outside them nobody can, and the token
drifts on its own.

Those are two different assets wearing one ticker. **SESSION splits them into
`X.DAY` and `X.NIGHT`**, and at each session boundary the inventory changes
hands. Because a day-holder wants to be flat at precisely the instant a
night-holder wants to be long, that handoff is a book entry rather than a
trade — only the *difference in size* between the two sides ever reaches a
market.

A brokerage cannot sell you this. Neither can any other tokenized-stock
product on Solana: they all sell the bundle.

## The evidence

Not a thesis. A measurement, over **83,322 hourly closes** and
**6,118 sessions** across 20 tokenized equities and 6 controls:

| | |
|---|---|
| Night volatility | **2.78%** |
| Day volatility | **1.90%** |
| The night is wider in | **18 of 20** names |
| Night minus day, per hour of exposure | **−1.37 bp**, t = **−1.31** |
| Night wins | **9 of 20** |

Read the last row carefully, because it is the one a pitch would hide: **there
is no overnight premium.** The anomaly that half this sector is built on does
not survive the measurement. What survives is that the night carries 46% more
volatility and pays nothing extra for it — which is a reason to *sell* the
night, not to buy it, and that is the product.

The controls behave exactly as the mechanism predicts: GLDx, which trades
24 hours with no session, shows no split. → `/research`

## Ninety seconds, in order

1. **`/`** — the clock is live and correct through DST, holidays and early
   closes. The finding is above the fold. So is the line saying what is
   actually deployed.
2. **`/markets/NVDAx`** — a real vault on devnet. Connect a wallet, take the
   faucet, mint the parked class. Every figure is read from the chain; the
   ledger at the bottom decodes the program's own events, so it says what
   happened rather than listing hashes.
3. **`/markets/OPENAI`** — the same program on a name with **no exchange
   session**. No NYSE clock anywhere on that page, because OPENAI has no
   09:30. The boundary is the next print, or the moment the token's executable
   price runs from the issuer's mark — read live from prestocks.com and posted
   on chain.
4. **`/bell`** — the keeper, launched on mainnet with its curve denominated in
   **real NVDAx**. The half worth reading is the list of things it *cannot* do.
5. **`/research`** — the measurement, including what it fails to find.

## What is real, and what is not

Stated the same way everywhere it appears, because a demo that hides this is
the thing this project is arguing against.

**Real, on chain, right now**
- The program, on devnet: settlement, funding, the handoff, the recap, the
  call auction, the halts. 156 Rust tests, including a year-long adversarial
  simulation across 40 seeded runs.
- Two vaults. One equity-session, one event-session.
- A Meteora DAMM v2 pool for `NVDA.DAY`, with a swap verified: 10 DAY in,
  9.92 quote out.
- `$BELL` on **mainnet**, quoted in **real NVDAx**.
- The detector on the OPENAI vault: the live mark and executable price from
  prestocks.com.

**Not real yet, and why**
- **The vaults hold stand-ins.** Devnet has no xStocks, no USDC and no pre-IPO
  tokens. The mints are built to the same *shape* — Token-2022 with a
  permanent delegate, a pause switch, a scaled-UI multiplier, a 1% transfer
  fee where the real one has it — because those are the code paths that have
  to work. Building the easy version is how a real bug survived a whole phase
  here (see below).
- **The mark is Pyth's `Crypto.SOL/USD`.** No tokenised-equity feed is
  sponsored on devnet.
- **Mainnet costs more than this has.** The program is 854,600 bytes; rent
  alone is **5.95 SOL** settled and **11.9 SOL** peak during the deploy, before
  a share of inventory. The wallet holds 0.25. → `docs/PHASE-F.md`

## The bug worth knowing about

The audit said the program could not hold a real xStock. The obvious half was
the token program: `Account<'info, Mint>` owner-checks against classic SPL, so
a Token-2022 mint failed validation. Fixed, and a vault shaped like NVDAx went
live.

It was still wrong. Anchor's `init` sizes a token account by calling
`get_extension_types()` on the mint, and that returns `InvalidAccountData` for
any extension the pinned `spl-token-2022` predates. **NVDAx and OPENAI both
carry two such extensions.** Reading works — every read path tolerates unknown
extensions — so nothing caught it until a mint was built with the extensions
the real asset actually has.

The first fix was wrong too: a local table of which mint extension obliges
which account extension, mirrored from the stale dependency, which missed
`PausableAccount`. The working fix asks the chain — `GetAccountDataSize` puts
the question to the deployed token program, which knows every extension there
is.

Four tests pin it against real mainnet bytes, including one that **fails when
a future `spl-token-2022` learns these extensions**, so the workaround is
removed rather than forgotten.

## Where it rests on somebody's word

One place, named on the page it affects: **the event-session detector.** No
oracle prices a pre-IPO token, so an operator posts the issuer's mark and the
executable price. The program bounds how stale that reading may be, records
who posted it, and refuses to settle on one it cannot trust. It cannot make
the reading true, and `/markets/OPENAI` says so in its own footer.

Everything else is Pyth, with full verification required, a posted-slot bound,
and a publish-time window around the bell itself.

---

`docs/OPERATIONS.md` is the runbook. `docs/AUDIT.md` is the adversarial
record, including the findings that turned out to be wrong.
