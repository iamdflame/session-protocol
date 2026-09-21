# Running a SESSION vault

The program is built so that the worst a keeper can do is cause delay, and the
worst an ambiguity can do is stop the vault. Almost everything below is
therefore about noticing early, not about intervening fast.

**The one rule:** a halted vault is the protocol working. It stopped because it
could not determine who was owed what, and stopping was the correct answer. Do
not rush to clear it — find out what produced it first.

---

## Deploying

Prerequisites: `anchor 0.31.1`, `agave 2.3.x`, a funded authority key.

```bash
cargo test -p session                 # 103 unit + property tests
cargo test -p session --test simulation   # 40 randomised year-long lifecycles
npm run test:ts                       # calendar, layout, health, instruction encoding
```

All three must pass before a build is deployed. The layout test in particular:
it is the only thing standing between a struct reordering and a client that
reports the wrong field at the right-looking magnitude.

### Building the program

```bash
cargo build-sbf                        # → target/deploy/session.so
```

The build must finish with **no** "Stack offset ... exceeded" line. That line
is printed as a warning and the artifact is still written, but on chain it is
an access violation in whichever instruction overran. `InitializeVault` boxes
its vault account for exactly this reason.

**Do not run a bare `cargo update`.** platform-tools v1.48–v1.50 ship Cargo
1.84, which cannot parse a crate on edition 2024, and the current releases of
seven *host-side* crates require 1.85 (`proc-macro-crate`, `toml_edit`,
`indexmap`, `hashbrown`, `unicode-segmentation`, `getrandom 0.4`, `proptest`).
`Cargo.lock` pins each to its last pre-1.85 release; a blanket update re-pulls
them and the SBF build fails at manifest parsing. Update crates individually
with `cargo update -p <crate>@<ver> --precise <ver>`, or move to a
platform-tools release whose Cargo is ≥ 1.85 and drop the pins. None of the
seven is in the program's own dependency graph — they are proc-macro and
test-only — so the pins change nothing that ships.

### The share classes

`NVDA.NIGHT` and `NVDA.DAY` are Token-2022 mints carrying their own on-chain
metadata, so a wallet shows the ticker rather than a base58 address. Nothing
else about them is a 2022 feature — no fee, no hook, no delegate, no pause.
An event vault names them `NOW` and `THEN` instead, on the same two mints.

The off-chain half is `{metadata_base}/{TICKER}.json`, supplied at creation:
the program owns no domain and does not pretend to. An empty base is legal
and leaves the names on chain regardless.

That a class shaped this way can still back a Meteora pool was settled on
devnet before the program changed — `npm run gate:pool`.

### Token-2022

The underlying and the quote can live under different token programs, and for
a real vault they do: every xStock is Token-2022 and USDC is the classic SPL
program. `initialize_vault` therefore takes **two** program accounts, and each
CPI is routed at the one owning the asset it moves. The share classes are
created under the quote program — they are this program's own mints with no
extensions, so 2022 buys nothing and costs wallet compatibility.

What the code cannot fix, and an operator must accept before listing an asset:

| NVDAx extension | what it means for a vault |
|---|---|
| `PermanentDelegate` | the issuer can move the vault's inventory out at any time |
| `PausableConfig` | the issuer can stop all transfers, which strands settlement |
| freeze authority | the issuer can freeze the vault's own token account |
| `TransferHook` | currently **unset**; if the issuer sets one, every transfer needs the hook's extra accounts and this program does not pass them |

The first three are properties of the asset that any holder already lives with.
The fourth is a live dependency: check it before listing, and check it again
after any issuer upgrade.

```bash
npm run test:validator    # a local validator with the real mainnet NVDAx,
                          # USDC and Pyth receiver cloned in
```

That test needs a CPU with AVX2 — `solana-test-validator` aborts at startup
without it — and the machine this was developed on is an Ivy Bridge i5-3427U,
which predates AVX2 by a year. The test says so itself rather than printing a
bare `SKIPPED`, naming the CPU and whether the flag is there, because a skip
with no reason is indistinguishable from a test somebody switched off:

```
SKIPPED — solana-test-validator aborts without AVX2, and this CPU has none.
          Intel(R) Core(TM) i5-3427U CPU @ 1.80GHz
          AVX2: absent
```

It has not run in CI either: the account's GitHub Actions are locked for
billing, so every push fails in about four seconds without starting a job.
**The assertions in that file have never been executed anywhere** — they are
the only proof that the program can custody a real Token-2022 asset with its
extensions on, and they are outstanding. Run it on any machine newer than
2013.

### Deploying the program

```bash
solana-keygen pubkey target/deploy/session-keypair.json   # must print 8gWC37…KqKZ
solana program deploy target/deploy/session.so \
  --program-id target/deploy/session-keypair.json \
  --url <cluster> --keypair ~/.config/solana/id.json
```

Costs the rent-exempt minimum for the program account (≈2.64 SOL for a 518 KB
binary at current rent) plus fees; the deployer keypair becomes the upgrade
authority. The program id is baked into the SDK (`sdk/src/vault.ts`) and the
site's PDAs, so deploying under a *different* keypair means changing
`declare_id!`, `Anchor.toml` and `PROGRAM_ID` together, then rebuilding.

### Devnet

There is a live devnet deployment, and the site is wired to it.

| | |
|---|---|
| program | `8gWC37AFvgnPMAZSqiimbkpqPVhF3PrA1rao5agVKqKZ` |
| vault | `DqdXeMbPHiDMMrVPeiGDBCNtDAxtMZNtEtTLN4eYoBti` — NVDAx stand-in: Token-2022 underlying with a permanent delegate, classic-SPL quote, Token-2022 share classes |
| manifest | `keeper/.devnet/manifest.json`, served by the site as `/devnet.json` |
| operator | `keeper/.devnet/operator.json` (gitignored); mint authority for the test tokens, the faucet signer and the crank/fill signer. Its secret is `OPERATOR_KEYPAIR` in the Vercel environment. |

Devnet has no xStocks, no USDC and no sponsored feed for any tokenised
equity, so the vault uses two test mints and takes its mark from Pyth's
`Crypto.SOL/USD`, with `Crypto.BTC/USD` as the session detector (a feed that
never goes quiet never trips it). `max_stale_secs` is 900 rather than 120
because Pyth refreshes the sponsored devnet feeds every few minutes, not every
second. Everything else is the mainnet program doing the mainnet thing.

```bash
npm run devnet:init     # once: mints, vault, operator inventory, manifest
npm run devnet:crank    # one settle + fill cycle from a terminal
npm run devnet:check    # prove every instruction's encoding against the program
```

The crank is also a serverless endpoint (`GET /api/crank` on the site): the
vault page pings it when its calendar says a bell has passed, and a Vercel
cron pokes it after each bell. Anyone can call it; `settle_boundary` takes no
signer. `POST /api/faucet { wallet }` mints 10,000 test quote and drips fee
SOL to an empty wallet, capped at 50,000 held.

### Choosing the assets

A vault needs an underlying whose *underlying* actually closes. The whole
economic basis of the split is the arbitrage gap while the real market is shut,
so:

- **Good:** xStocks tracking US equities (`NVDAx`, `SPYx`, `AAPLx`).
- **Pointless:** `GLDx`. Gold trades ~24h globally, there is no closed session,
  and the research shows no session effect — as the mechanism predicts.
- **Wrong:** PreStocks. Private companies have no exchange session at all, so
  `Equity.US.<SYM>/USD` does not exist and the session oracle has nothing to
  cross-check against.

### Feeds

Three Pyth feeds, and the vault will not initialise without the first two:

| feed | role |
|---|---|
| `Crypto.<SYM>X/USD` | the mark for NAV — the vault holds the **token** |
| `Equity.US.<SYM>/USD` | session detector; its *staleness* is the closing bell |
| `Crypto.<SYM>X/<SYM>.RR` | the basis, for monitoring |

`mark_feed_id` and `equity_feed_id` must differ, and both are immutable after
initialisation. Changing what a vault tracks is a new vault, not a parameter
change.

### Parameters

Every bound is enforced on chain; these are the values to start from.

| parameter | start | reasoning |
|---|---|---|
| `funding_k_bps` | 2500 | 25% sensitivity to skew |
| `funding_max_bps` | 50 | 50bp **per boundary** — ~22%/month at maximum skew (50bp x 2 bells x 22 days), reached only when one class is worth far more than the other. Raise deliberately: the ceiling is 1000 (10% per bell). |
| `max_stale_secs` | 120 | Pyth publishes far faster; this only catches outages |
| `max_conf_bps` | 100 | refuse to settle when Pyth is 1% unsure |
| `max_move_bps` | 2000 | a 20% jump between boundaries needs a human |
| `equity_quiet_secs` | 900 | 15 minutes of equity silence means the market is shut |
| `max_unexpected_closed_secs` | 21600 | a nominal session silent this long is a fault, not a holiday |
| `fill_incentive_bps` | 10 | against a measured ~10bp one-way cost on the residual |
| `max_carry_delta_bps` | 200 | above 2% unfilled, stop rather than compound |

`fill_incentive_bps` is the one to tune in practice. Too low and imbalances sit
unfilled until `max_carry_delta_bps` halts the vault; too high and every fill
charges the crowded class more than the imbalance cost. Start at the measured
execution cost and raise it if `unfilled-handoff` signals persist.

---

## Normal operation

```bash
node --experimental-strip-types keeper/src/index.ts --watch \
  --vault <pubkey> --mark <pubkey> --equity <pubkey> \
  --keypair ~/.config/solana/keeper.json --rpc <url>
```

The keeper polls every 30 seconds — far more often than boundaries arrive,
because the point is to notice a developing problem hours before it becomes a
halt. It submits `settle_boundary` when one is due and otherwise only reports.

Two boundaries a trading day, plus one long one across each weekend. A Friday
close to Monday open is a single 65.5-hour NIGHT position.

### Keeper failure is survivable, briefly

A revert is usually transient — a stale mark, a wide confidence band. The
boundary stays settleable **for the rest of that session**, so retrying is the
correct response and the keeper does it automatically.

Past the *next* boundary the window closes and the vault halts, because the
mark at the intermediate boundary is gone and no price available later can
reconstruct who was owed what. In practice: a keeper outage under ~6 hours
costs nothing; one that spans a session needs manual recovery.

---

## Health signals

`--health` prints one report. Severity is the worst active signal.

| signal | severity | what it means | do |
|---|---|---|---|
| `insolvent` | critical | assets are below claims | halt immediately, reconcile before any redemption |
| `halted` | critical | the vault stopped | follow the halt table below |
| `balance-shortfall` | critical | token balances below what the vault thinks it owns | halt and investigate — should be unreachable |
| `crank-late` | notice → critical | a boundary is unsettled | escalates as the session runs out; at critical, settle now |
| `unfilled-handoff` | notice → critical | imbalance outstanding | raise `fill_incentive_bps` or fill directly |
| `mark-stale` | warning | mark feed quiet past `max_stale_secs` | settlement and fills revert until it recovers |
| `equity-feed-quiet` | warning → critical | quiet during a *nominal* session | unencoded holiday or a halt; at critical the vault stops |
| `extreme-skew` | notice | one class holds >80% more value | funding is already capped; expect large handoffs |
| `surplus` | notice | tokens transferred in outside `mint_shares` | `skim_surplus` |
| `paused` | notice | trading flags set | intentional unless nobody set it |

Alert on `critical` immediately. Alert on `warning` if it persists past one
session. `notice` belongs in a dashboard, not a pager.

---

## Halts and how to clear them

Two instructions, and a rule between them.

`recap` replays the bells a halted vault missed, one mark each, through the
same `settle()` the live path runs. The calendar decides which bells those
are — an entry whose timestamp is not the next bell is refused — and the
operator supplies only prices. Each price is either **verified** (a Pyth
update from that bell's own window, posted alongside; the program takes the
mark from it) or **attested** (the operator's word, bounded by
`max_move_bps`). The receipt event says which, carries a hash of what was
submitted, and the instrument card shows the mode.

`resolve_halt` resumes a vault and writes **nothing** to the accounting. It
refuses while any bell is unaccounted for (`RecapRequired`), while a handoff
residue exceeds the carry limit (`ResidueTooLarge`), and while an issuer
condition still holds. It also requires naming the reason being cleared, so a
stale pre-signed transaction cannot clear a halt it was not written for.

There is no path that resumes with missed sessions unpaid. If a replayed bell
wipes the exposed class, the replay stops unless `--absorb` names the only
place the remainder can go — the other class — and that choice is in the
event.

```bash
npm run devnet:recap -- --dry-run          # which bells, which source
npm run devnet:recap                       # HERMES_API_KEY: Pyth's prints, verified
npm run devnet:recap -- --marks <ts>=<mark>,...   # attested, on your word
npm run devnet:recap -- --absorb --resume  # explicit, and then resume
```

### `MissedBoundary`

Two or more bells elapsed without a crank.

1. `recap`. With a Hermes key the marks are Pyth's own and the operator
   chooses nothing. Without one, attest them from a source you can defend and
   expect the move bound to hold you to it.
2. The replay produces a handoff residue for every bell, since nobody filled
   between them. Fill it — `fill_handoff` is permitted during this halt.
3. `resolve_halt(MissedBoundary)`.

### `UnfilledHandoff`

An imbalance above `max_carry_delta_bps` was still outstanding when a bell
arrived. That bell was **not** settled.

1. Fill it: `fill_handoff` until `pending_delta` is under the limit. Allowed
   while halted for this reason — it is the remedy.
2. `recap` the bell that was refused (and any since).
3. Work out why nobody filled. Usually the incentive ramp tops out below the
   real execution cost, or the pool is too thin for the vault's size. Raise it
   via `set_params` before resuming, or the next bell halts the same way.
4. `resolve_halt(UnfilledHandoff)`.

### `BadDebt`

A bell's move produced a loss larger than the exposed class was worth. Only
reachable when an unfilled handoff left the vault badly over-hedged and the
price then moved against the inventory. Nothing was applied — the settlement
was refused, not half-done.

1. `recap` that bell. Without `--absorb` the replay refuses, which is the
   program telling you the class is wiped.
2. Decide, on purpose: `--absorb` charges the remainder to the other class,
   the only place it can go, and the `Recapped` event records `absorbed` (and
   `unabsorbed`, if both classes reached zero). Or wind the vault down.
3. Fill the residue; `fill_handoff` is permitted during this halt.
4. `resolve_halt(BadDebt)`.

### `IssuerAction`

The underlying's issuer used a power the vault cannot override: set a transfer
hook, paused the mint, froze the vault's token account, or moved inventory out
under a permanent delegate. The halt detail says which. Nothing this program
can do clears it; `resolve_halt(IssuerAction)` re-checks the condition and
refuses while it holds. Once it clears, `recap` any bells that passed, then
resolve.

### `Inconsistent`

The stored session contradicts the calendar, or the equity feed stayed quiet
through a nominal session past `max_unexpected_closed_secs`.

1. Check whether the market was genuinely shut — an unencoded holiday, or an
   exchange-wide halt.
2. If the calendar is wrong, that is a program fix, not a parameter change.
   A vault in this state cannot be recapped or resumed: there is no trusted
   position to replay from.

### `Operator`

Somebody called `halt`. Bells that passed meanwhile are recapped like any
other, then `resolve_halt(Operator)`.

---

## Keys and authority

- The authority can change parameters, pause trading, halt, resolve and skim.
  It **cannot** move user funds, change the feeds, or alter NAV.
- Rotation is two-step: `transfer_authority(next)` then `accept_authority`
  signed by the new key. A mistyped address cannot strand the vault, because it
  only takes effect once the new key proves it exists.
- The keeper key needs only lamports for fees. It holds no privilege.

## Pausing

Pause bits are `PAUSE_MINT`, `PAUSE_REDEEM`, `PAUSE_FILL`.

**Settlement is deliberately not pausable.** Freezing NAV while the price keeps
moving means the first boundary after resuming hands one class the entire
suppressed move. Pausing must stop *trading* without corrupting *accounting*.
To stop everything, use `halt`.

## Unaccounted tokens

Anyone can transfer into the vault's token accounts. The program tracks owned
balances separately and never reads `token_account.amount` for accounting, so
a donation cannot perturb NAV, pricing, or settlement. It shows up as `surplus`
and is swept with `skim_surplus`.

A balance *below* the owned figure should be unreachable. Treat it as a
compromise, halt, and investigate.

---

## What is not covered

- **No mainnet deployment yet.** xStocks exist only on mainnet, so validator-backed
  integration needs cloned accounts; see `Anchor.toml` for the set. The current
  local SBF toolchain (platform-tools v1.48, Cargo 1.84) cannot resolve the
  dependency graph because transitive crates now require edition 2024. The
  program builds and is tested as a library; producing the `.so` needs a newer
  platform-tools than is installed here.
- **No upgrade has been exercised.** `version` is checked on every instruction
  and mismatches are rejected, so a stale client fails loudly rather than
  misreading — but no migration has actually been run.
- **Funding parameters are unproven.** `funding_k_bps` and `funding_max_bps` are
  reasoned defaults, not calibrated ones. There is no live market yet to
  calibrate against, which is precisely what the protocol exists to create.
