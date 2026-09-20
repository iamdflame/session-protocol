# Prism

**Every belief is a bundle of bets. Most of them aren't yours.**

Prism takes a sentence — *"AI is a bubble but Anthropic survives it"* — splits it into
the factors it is secretly exposed to, and lets you strip out every bet you didn't
mean to make. What's left is the position that is actually your idea.

Built for [STOCKLANA](https://hackathons.solana.com/hackathons/stocklana).

---

## The problem

Nobody has a view shaped like a ticker.

People have views shaped like sentences: *robotaxis are further away than the market
thinks*, *private AI labs eat big tech*, *the defense buildout is underpriced*. The
market only sells tickers, so you translate — and the translation is where the idea
dies.

Say you think robotaxis are further away than the market believes. The obvious trade
is to short Tesla. One position, done. Here is what you would actually own — measured,
not asserted:

| | share of your risk |
|---|---|
| the stock market going down | **47.1%** |
| a defensive-sector rotation | 15.5% |
| three other factor exposures | 7.6% |
| **the opinion you actually had** | **39.9%** |

You wanted one bet. You made five, and the biggest one is a call on the S&P that you
never made. Separating them out requires a factor model and a short book — which is to
say, a hedge fund.

Strip the market band and Prism rebuilds the position: **76%** of the risk is now your
idea, correlation to the S&P falls from **−0.57 to −0.02**, and annualised volatility
drops from **48% to 19%** — the same opinion, expressed with 60% less risk. Those
numbers print from `npm run check`; none of them are illustrative.

Every tokenized-stock app so far assumes you already know which ticker you want.
Prism is for the much more common case where you know what you *think*.

## The trick

Type a belief. Watch it refract.

```
        your belief ──▶ ◢ ──┬──▶  Market beta ................ 47.1%
                            ├──▶  Big tech vs semiconductors ..  1.8%
                            ├──▶  Index beta vs crypto proxies   2.4%
                            ├──▶  Private markets vs the AI trade 0.7%
                            ├──▶  Defensive / staples ......... 15.5%
                            └──▶ ★ YOUR ACTUAL IDEA .......... 39.9%
```

Click a band and it's projected out of your position. The light re-refracts, the book
below rewrites itself, and the number you care about grows. The band widths *are* the
variance shares — the picture is the arithmetic, not an illustration of it.

Then the falsifiable part: Prism replays both weight vectors over real history and
shows you the correlation of each to the S&P. If the refracted position is genuinely
market-neutral, that number goes to roughly zero. If it doesn't, the claim was false
and you can see it.

## Why this needs Solana

Prism's universe holds **private companies and public companies in the same position**.

`OpenAI` and `Alphabet` in one book. `Anduril` short against `Palantir`. `SpaceX` next
to `NVIDIA`. There is no brokerage on Earth where those can be legs of the same order —
pre-IPO equity is locked behind accreditation, SPVs, and lockups, and it has no
continuous price at all.

On Solana both halves are SPL tokens in one composable namespace, both priced every
second, both routable through the same DEX aggregator. That is not "the same product,
faster." It is a position that could not previously be expressed.

Two further consequences, both load-bearing here:

- **A factor model over private companies.** Because PreStocks print a continuous price,
  you can compute a covariance matrix that includes OpenAI and Anthropic. Prism's
  "Private markets" factor is a real principal component discovered in real returns —
  an object that did not exist before these tokens did.
- **No shorting infrastructure required.** Prism never opens a new position; it
  *re-points money you already hold*. A short leg is an underweight. Every leg is a
  swap, so the whole thing routes through Jupiter with no borrow, no margin, no perps
  and no vault.

## The math

No black box. Four steps, all in [`src/engine.js`](src/engine.js).

**1 · Returns.** Daily log returns for every asset, from its deepest *honest* Solana
pool. Winsorised at ±4σ because thin pools print absurd candles. The window is chosen
to maximise assets × days, since these tokens have different birthdays.

**2 · Factors.** Correlation matrix → Jacobi eigendecomposition. The principal
components *are* the factors — discovered from the data, not declared. PC1 is always
"everything moves together"; the rest get named by correlating their loadings against
sector membership, so the label follows the data rather than the other way round.

**3 · The spectrum.** For weights `w`, exposure to factor `k` is `bₖ = vₖ·w` and the
variance it contributes is `bₖ²λₖ`. Divide by total variance `wᵀCw` and you have the
bands. Whatever no factor explains is the residual — and the residual is the only part
that is *your idea*. That is what idiosyncratic risk means.

**4 · The refraction.** Because principal components are orthonormal, projecting onto
the null space of the unwanted loadings collapses to a subtraction:

```
w ← w − Σ (vₖ · w) vₖ
```

Exact, closed form, instant. Clipping for tradeability knocks it slightly off-neutral,
so projection and clipping alternate a few passes — each one lands closer to both.

Run `npm run check` to see all of it printed from a terminal, with assertions that the
attribution sums to 1 and that refraction actually increases purity.

## Running it

```bash
npm run data     # discover universe → fetch history → build snapshot  (~12 min, rate-limited)
npm run check    # verify the engine against the snapshot
npm start        # serve on :8080
```

A committed snapshot lives in `data/universe.json`, so `npm start` works without
re-fetching.

Optional: paste an Anthropic API key into `localStorage.prism_key` and the sentence is
read by Claude instead of the built-in parser. The parser is the default and needs no
network — the demo never depends on a key.

## Data

| | |
|---|---|
| Spot, liquidity, holders | Jupiter Token API |
| Daily OHLCV | GeckoTerminal, pinned per-mint |
| Public equities | xStocks (Backed Finance) |
| Private companies | PreStocks |

Three traps the pipeline avoids, each of which silently corrupts this kind of dataset:

1. **Orientation.** Tokens are frequently the *quote* side of a pool (`WC / ANDURL`).
   Reading that pool's OHLCV naively returns the *other* token's price — which is how
   Anduril ends up with KIRKINATOR's chart. Every request is pinned with `?token=<mint>`.
2. **Dishonest pools.** A thin pool can quote far from where an asset really trades, so
   no single pool is trusted. Several are fetched and the **median last close** is taken
   as the reference; pools that disagree with it by more than 30% are dropped.
3. **A bad reference.** The obvious check — compare against Jupiter's `usdPrice` — is
   itself unreliable for thin pre-IPO tokens. For `OPENAI` that field reports **$1,144**
   while four independent pools *and* the executable Jupiter swap quote all agree on
   **~$1,701** (the token has 9 decimals). An earlier version of this pipeline trusted
   that field and threw OpenAI out of the dataset entirely. The pools decide; Jupiter's
   field is recorded for comparison and flagged when it disagrees.

## Layout

```
src/engine.js   eigendecomposition, attribution, projection, evidence
src/belief.js   sentence → naive position (local parser + optional Claude)
src/meta.js     company metadata, theme lexicon, polarity lexicon
src/app.js      the optical bench
scripts/        discovery → history → snapshot, plus the checker
```

There is deliberately no auth, no backend, no database and no custody layer. All of the
effort is in the one thing that makes this worth building.

## Honest limits

- The factor model sees ~6 months of daily data, because that is how long some of these
  tokens have existed. It is enough for a stable PC1 and interpretable PC2–PC5; it is
  not enough to claim anything about a regime it hasn't seen.
- PC1 explains ~23% of universe variance, well under the 40–60% a traditional equity
  risk model shows. That gap is real and worth naming: these tokens trade 24/7 against
  underlyings that trade 6.5 hours a day, and the overnight drift on thin pools is
  genuine idiosyncratic noise. It inflates the residual — so the "your idea" number is
  if anything generous, never flattering in the other direction.
- Driving the residual to 100% by stripping every factor is circular, and the interface
  is not built for it. The point is to strip the bands you didn't mean and keep the ones
  you did; the outputs that matter are the book and the measured correlation.
- Purity is measured against the factors Prism found. A risk it cannot see cannot be
  stripped.
- Underweighting is not shorting. A view needing true short exposure is expressed as
  far as a long-only book allows, and the residual says so.
- Research tool. Not investment advice.
