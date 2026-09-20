# Implementation gap analysis

Audit of the state at commit `f7f7235`. The pure math was well covered; the
*state machine around it* was not. Severity is by what an operator would lose.

## P0 — value is silently misattributed, lost, or unbacked

### 1. A missed boundary silently pays the wrong class an entire session

`settle_boundary` fired only when `class_for(session_at(now)) != vault.exposed`.
Exposure was therefore *inferred* from the current session rather than tracked,
so the vault could not tell "no boundary has happened" from "two boundaries have
happened and we are back where we started."

```
Fri 16:00  market closes      → NIGHT should take over   [crank missed]
Mon 09:30  market opens       → DAY should take over
Mon 12:00  crank runs         → session=Open, should_be=Day, exposed=Day
                              → NoBoundary. Nothing happens.
```

DAY keeps the entire 65.5-hour weekend, including every gap. NIGHT — the class
that exists specifically to hold that risk — earns nothing. No error is raised.
Any crank outage longer than one session corrupts the accounting permanently,
and the corruption is invisible.

**Fix:** track `last_session` explicitly, count elapsed boundaries, and refuse to
settle a stale boundary rather than guess. Missing a boundary must degrade into
a halt, never into a silent transfer.

### 2. Unfilled `pending_delta` was overwritten at the next boundary

`v.pending_delta = out.handoff_delta` discarded any residual the market had not
filled. Real inventory then diverges from what NAV claims, permanently, with no
record that it happened.

**Fix:** carry the residual, and refuse to settle while one is outstanding beyond
tolerance.

### 3. No solvency invariant anywhere

Nothing ever checked that

```
underlying_balance × mark + quote_balance  ≥  night_supply × night_nav + day_supply × day_nav
```

A vault could be under-collateralised and behave normally until redemptions
became first-come-first-served.

**Fix:** compute and enforce on every value-moving instruction; expose the margin.

### 4. Redemption could drain quote reserved for a pending handoff

With `pending_delta > 0` the vault owes the market a purchase funded from quote.
A redeemer could take that quote first, leaving the handoff unfillable.

**Fix:** reserve the pending amount; redemption may only touch free quote.

### 5. Value stranded when a class's supply reaches zero

With `supply == 0` the class keeps its NAV, its value reads as zero, and any
quote that belonged to it stays in the vault owned by nobody — while the handoff
maths continues to be computed on values that no longer match balances.

**Fix:** detect the empty-class transition explicitly and fold the residue into
the surviving class, or refuse the last redemption that would orphan it.

### 6. Unsolicited transfers into the vault's token accounts were unaccounted

Anyone can transfer to `quote_vault` / `underlying_vault`. NAV is tracked
explicitly so this is not an inflation attack, but balances and accounting drift
apart forever, which makes every solvency check ambiguous.

**Fix:** track owned balances explicitly and treat the excess as skimmable
surplus rather than pretending it does not exist.

### 7. `Vault::SIZE` was a guess (`8 + 512`)

Hand-counted space is a runtime failure waiting to happen.

**Fix:** derive it.

## P1 — security, authorization, lifecycle

8. **No `set_params`.** Oracle guards were immutable forever. If Pyth widens its
   confidence behaviour, every vault bricks with no recourse.
9. **No authority transfer**, so key rotation is impossible; a lost key is a dead
   vault.
10. **`paused` blocked settlement as well as trading.** Pausing freezes NAV while
    the price keeps moving, so the first boundary after unpausing hands one class
    the entire suppressed move. Pause must stop *trading* without corrupting
    *accounting*.
11. **No version field**, so no migration path and no way to reject an account
    written by a different program version.
12. **Initialisation under-validated**: no check that underlying ≠ quote, that the
    two feed ids differ, or that the equity feed account is real (only the mark
    feed was ever read).
13. **Oracle outage misattributes sessions.** A stale equity feed forces `Closed`,
    so NIGHT keeps earning through what should be DAY sessions, indefinitely.
14. **A rejected mark bricks the boundary.** `max_move_bps` rejects a legitimate
    large move; the boundary is then missed, which triggers P0 #1.

## P2 — operations and testing

15. No `Anchor.toml`; `anchor build` / `anchor test` could not run at all.
16. Events omitted supplies, so off-chain state could not be reconstructed.
17. Keeper never submitted a transaction — it printed a schedule.
18. No integration test against a validator; every test was a pure unit test.
19. No operator runbook, health signals, or alert conditions.

## What the existing tests hid

The suite was strong on `settle()` in isolation and proved nothing about the
program around it. Every P0 above lives in `lib.rs`, which had **zero** test
coverage — the 46 passing tests created the impression of a tested system while
the entire state machine, authorisation surface and solvency model were
unexercised.

---

# Second pass — found by the adversarial simulation

The first pass fixed what reading the code revealed. These three were found by
running long randomised sequences and asserting solvency after *every* step.
None would have been caught by testing operations one at a time, and all three
are silent: the vault keeps working and the gap keeps growing.

### 10. NAV rolled by the price ratio, not the inventory actually held

Settlement multiplied the exposed class's NAV by `P₁/P₀`. That is correct only
while the vault holds exactly that class's value in stock. When a handoff goes
unfilled it does not, and claims then move by the *assumed* return while assets
move by the *real* one. The difference comes out of everyone's backing.

Now `Δnav = U·(P₁−P₀)/supply`, computed from the inventory the vault actually
held. The two agree exactly when hedged — substituting `U·P₀ = supply·nav`
recovers the multiplicative roll — and diverge precisely when they should.

### 11. Losses rounded the wrong way

Gains floored *and* losses floored. Flooring a loss means claims shrink more
slowly than assets, so every down move left claims fractionally above backing.
Individually dust; cumulatively an insolvency, and one that only ever grows.

Gains now floor and losses ceil, so claims can never outrun assets.

### 12. The sell side of a fill leaked an atom

`gross` floored in both directions. Selling, that let a filler take stock worth
marginally more than they paid — about one atom per fill, never reversing, and
chosen by the filler, who picks the size.

Rounding is now against the filler in both directions: floor when the vault
buys, ceil when it sells.

### 13. Bad debt was silently absorbed

A loss larger than the exposed class is worth wiped it to zero and let the
remainder fall on the other class's backing. Reachable whenever an unfilled
handoff leaves the vault badly over-hedged and the price then drops — the
simulation hit it with the vault holding ~199k of stock against a class worth
~3k.

`settle` now reports a `shortfall` and the program halts without applying
anything, so the state that produced it is preserved for an operator.

## What the simulation is for

Three of these are rounding-direction bugs. Every one passed the unit tests,
because a single operation loses an atom and an atom looks like nothing. They
are only visible as a trend across thousands of operations, which is why the
suite now runs 40 randomised year-long lifecycles and checks solvency after
every mint, redeem, fill and settlement rather than at the end.

Under that load 4 of 40 runs trip a guard — enough to prove the guards fire,
not so many that they fire spuriously.

# Third pass — found while building the product on top

Two findings from putting a website and a devnet deployment on the program.
Neither is in the settlement maths; both would have shipped wrong numbers.

### 14. A single bad print became a permanent 12% cliff in one class

A thin-pool fill put one hourly close 12% below its neighbours and the next
bar put it straight back. Harmless on its own. But the recovery bar landed
exactly on the 16:00 ET bell — 20:00 UTC — so it straddled a boundary and was
dropped as unattributable, while the drop before it was charged in full to
DAY. SPYx's day curve fell off a cliff that never happened, and the study's
headline figure inherited it.

**Fix:** `research/clean.ts` rejects a bar that sits far from *both* its
neighbours while they agree with each other, with the threshold scaled to the
asset's own median hourly move (a fixed 6% cut shredded TQQQx, a 3× ETF). 38
of 83,322 bars. The study and the site's data prep import the same function,
and the site's headline figures are computed at build time from the study
rather than typed into prose, so the two cannot disagree again. The corrected
result is stronger: 46% more overnight volatility, wider in 18 of 20.

### 15. `InitializeVault` overran the SBF stack frame by 8 bytes

Surfaced the first time the program was actually built for the chain: the
account-validation function for `initialize_vault` needed 4,104 bytes of a
4,096-byte frame. The toolchain prints this as a warning and writes the
artifact anyway; on chain it is an access violation in the one instruction
that creates a vault.

**Fix:** box the vault account so it is deserialised on the heap. No semantic
change. The runbook now says a build with that warning is not deployable.

### Also: the SBF build itself

The program could not be built for the chain because seven *host-side*
crates (proc-macro and test dependencies — none in the program's own graph)
had moved to Rust edition 2024, which the toolchain's Cargo 1.84 cannot parse.
`Cargo.lock` pins each to its last pre-1.85 release; a bare `cargo update`
undoes that. Recorded in the runbook because it will bite the next person.

## Verified on chain

The program is deployed on devnet and a vault is initialised. Every
instruction's account list has been sent to it: mint and redeem executed and
reconciled; `settle_boundary` and `fill_handoff` reach the program's own logic
and are refused for the right reason (no boundary elapsed, nothing to fill)
while a deliberately swapped account list is refused earlier by an Anchor
constraint. The first settlement runs at the first bell after initialisation.
