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

That test needs a CPU with AVX2 — `solana-test-validator` aborts without it,
which is why this repository had no validator test for so long.

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
| vault | `3BgELitNWgPNQ9qsWM8tPDAAkcAPM8mtbpnPgogAJ9ZB` — NVDAx stand-in |
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

`resolve_halt` requires naming the reason being cleared, so a stale pre-signed
transaction cannot clear a halt it was not written for. Resolving re-anchors the
session, exposure and boundary timestamp to *now*.

### `MissedBoundary`

Two or more boundaries elapsed without a crank. The intermediate mark is gone.

1. Establish from off-chain data what the mark was at each missed boundary, and
   what each class *should* have earned.
2. Decide whether the difference is material. Over one weekend on a quiet name
   it is often dust; over a week it is not.
3. If material, settle the difference out of band before resuming — there is no
   on-chain path to retroactively attribute a session, deliberately.
4. `resolve_halt(MissedBoundary)`.

### `UnfilledHandoff`

An imbalance above `max_carry_delta_bps` was still outstanding when another
boundary arrived. The vault is holding the wrong inventory.

1. Fill it: `fill_handoff` until `pending_delta` is near zero.
2. Work out why nobody filled it. Usually `fill_incentive_bps` is below the real
   execution cost, or the pool is too thin for the vault's size.
3. Raise the incentive via `set_params` before resuming, or the next boundary
   halts the same way.
4. `resolve_halt(UnfilledHandoff)`.

### `BadDebt`

A price move produced a loss larger than the exposed class was worth. Only
reachable when an unfilled handoff left the vault badly over-hedged and the
price then fell.

1. Nothing was applied — the settlement was refused, not half-done.
2. The exposed class is close to worthless at the attempted mark. Check whether
   the shortfall in the `VaultHalted` event exceeds the class's remaining value.
3. This is a capital decision, not an operational one: either the shortfall is
   absorbed from outside, or the class is wound down.
4. Only then `resolve_halt(BadDebt)`.

### `Inconsistent`

Either the stored session contradicts the calendar, or the equity feed stayed
quiet through a nominal session past `max_unexpected_closed_secs`.

1. Check whether the market was genuinely shut — an unencoded holiday, or an
   exchange-wide halt.
2. If the calendar is wrong, that is a program fix, not a parameter change.
3. `resolve_halt(Inconsistent)` once the feed is publishing normally again.

### `Operator`

Somebody called `halt`. `resolve_halt(Operator)` when done.

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
