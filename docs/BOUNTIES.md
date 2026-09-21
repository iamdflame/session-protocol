# What we entered, and what we refused

The platform allows three sponsor tracks. Picking more would mean building
toward a checklist instead of toward a protocol, so the constraint is useful
and this is the reasoning, including the parts where a track was left on the
table.

---

## Entered

### PreStocks — `/markets/OPENAI`

The same program, on a name with no exchange behind it. `OPENAI` has no 09:30
and no close, so putting it on a NYSE clock would be a lie with a countdown
attached. The classes are `NOW` and `THEN`, the boundary is the next print or
a premium that runs, and the detector reads the live mark and executable price
from prestocks.com and posts both on chain.

The vault came up `exposed=THEN` on its own, from a real reading — the premium
was 10.62% against a 10% tolerance — rather than from a number chosen to make
a demo work.

**The eligibility rule is enforced by CI, not by intention.** PreStocks
disqualifies any submission carrying a competing pre-IPO mint, so
`.github/workflows/ci.yml` greps the tracked tree for them and fails the
build. A rule kept in a document is a rule nobody enforces.

### Meteora — `NVDA.DAY/quote`, DAMM v2

The README claimed DAY is always exitable. Mint and redeem work only while a
class is *parked*, so for the 6.5 hours DAY is exposed its holder was stuck
unless somebody would buy it — which made the claim false for a third of every
weekday. A pool is what turns it into a fact, and the swap is verified rather
than asserted: 10 `NVDA.DAY` in, 9.92 quote out, 80 bp for fee and impact.

**On "session-aware fees", which we will not claim.** Neither DBC nor DAMM v2
has a wall-clock schedule, so it cannot mean "a different fee after 16:00".
What DAMM v2 does have is a dynamic fee that rises with realised volatility,
and the night is where the volatility is — 2.78% against 1.90%, measured over
305 sessions. The pool charges more at night because the night *is* more
expensive, arrived at by the market rather than asserted by a clock we set.

Two pools are deliberately missing. `NIGHT` is exposed as of writing, a class
can only be minted while parked, so its pair and the `NIGHT/DAY` implied
overnight wait for the next bell. That is the design working, and the tool
says which and why instead of failing.

### Clawpump — `$BELL`, on mainnet

`7z9y4P3yatZki2AHHtzjPxEhjVTP1d362BQH1kDPdQTe`, with the curve denominated in
**real NVDAx** rather than SOL. The agent is the keeper: it rings the session
boundary, settles it, and clears the residual. Its token being priced in the
stock means holding it is a position in the thing being kept.

`/bell` shows the launch, the payment, the agent's own wallet — and the list
of things it *cannot* do, which is the half that matters. Cranking is
permissionless, so a keeper that is late, absent or hostile causes delay and
never loss.

Cost: **0.009223 SOL**. The launcher refuses to spend without `--confirm` and
prints the amount and the payee first.

---

## Refused

### Tessera

Would forfeit PreStocks. Their rule disqualifies any submission integrating a
competing pre-IPO mint, and a resolution-session product is a different
program instance in a different repository — not a second pre-IPO token in
this one. CI fails the build on the mention.

### Pyth

No cash prize, and a submission has three slots. Pyth is load-bearing
regardless: full verification is required, `posted_slot` is bounded, and a
settlement mark must fall inside a window around the bell itself rather than
being whatever the crank happened to read. The equity feed going quiet is the
bell. None of that changes for want of a ballot.

---

## What we did not build, and why

- **A mainnet `$BELL/NVDAx` DAMM v2 pool.** Clawpump has no trading endpoints,
  so seeding it would mean buying `$BELL` off a pump.fun curve quoted in a
  non-SOL asset — real integration work for a roughly $20 pool competing with
  the curve that already exists. The curve *is* the stock-paired pool.
- **Kamino, idle yield on parked quote.** A real integration with real risk,
  and not the wedge. Documented as a consequence of the primitive, not built.
- **A basket (`Mag7.DAY`).** It is the consumer product that follows from five
  equity vaults existing. There are two.
- **Twenty-six mintable curves.** A catalog of unlisted names is honest; a
  grid of simulated markets that mint is not. Those pages now say so
  permanently rather than once in a dismissible notice.
