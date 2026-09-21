# Who can change this, and what that lets them do

Every protocol that holds someone else's money has a key that could take it.
Most of them describe the key as a safety feature. This page describes what
each one can actually do, in the order that matters — the program's upgrade
authority first, because it makes every other line on this page moot.

Everything below is true of the devnet deployment today. The last section is
what has to change before it holds anything real, with the cost of each step,
because "we'll decentralise later" without a number attached is not a plan.

---

## 1. The upgrade authority — the one that matters

**`92mjWBzNbrhrvDumoGk4BM4oS5oCDgjbXAH81z3jhu7M`**, a single key in a file on
one laptop. It can replace `8gWC37AFvgnPMAZSqiimbkpqPVhF3PrA1rao5agVKqKZ` with
a different program at any time, and the replacement inherits every vault PDA
and every token account those PDAs sign for.

So: **whoever holds that key can take the inventory of every vault.** Not
through a bug — through the ordinary, documented behaviour of an upgradeable
Solana program. No parameter bound, two-step handover or halt condition on the
rest of this page survives an upgrade, because the upgrade replaces the code
that enforces them.

This is stated first and without qualification because the alternative — a
long list of careful guarantees, with this one in a footnote — is how a reader
comes away with the wrong idea about a true fact.

## 2. The vault authority

Per vault, currently the operator key `GNJxWx5AWfdyQfpu4BEMAmBQzQX7QSKMhDzFBRTShfYi`.
Handed over in two steps: `transfer_authority` proposes, and the proposed key
must send `accept_authority` itself, so a mistyped address cannot strand a
vault.

**What it can do**

| Instruction | Effect |
|---|---|
| `halt` | stops minting, redeeming, settling and filling |
| `set_flags` | pauses mint, redeem or fill individually |
| `set_params` | changes the operating bounds, within the limits in §3 |
| `set_schedule` | the event list an event-session vault settles against |
| `set_detector_authority` | who may post the event-session reading |
| `recap` | replays boundaries the vault slept through, at operator-supplied marks |
| `resolve_halt` | clears a halt whose cause is gone |
| `skim_surplus` | withdraws tokens **above** every recorded claim |
| `transfer_authority` | proposes a successor |

**What it cannot do**

- **Mint shares to itself.** `mint_shares` takes quote in and prices at NAV.
  There is no authority path to a share.
- **Move inventory that is claimed.** `skim_surplus` sends only
  `balance − claimed`, where the claim includes every share outstanding and
  every bid escrowed in an open auction. At a correctly funded vault it moves
  nothing, and `NothingToSkim` is the ordinary answer.
- **Change the price feeds.** `set_params` rejects a different `mark_feed_id`
  or `equity_feed_id` with `ImmutableField`. A vault cannot be re-pointed at a
  feed the authority controls.
- **Invent a boundary.** `recap` supplies *marks*; every timestamp must equal
  `calendar::next_boundary(prev)`, each mark is bounded by `max_move_bps`
  against the one before it, and a step that would leave a shortfall is
  refused outright rather than absorbed.
- **Settle.** `settle_boundary` takes no signer at all. Anyone can crank it,
  and the program reads the mark from Pyth with full verification required.

## 3. The bounds the program enforces on its own operator

`set_params` runs `VaultParams::validate` before anything is written, so these
are limits on the authority rather than conventions it follows:

| Parameter | Ceiling |
|---|---|
| `funding_max_bps` | 1,000 — 10% per boundary, the most funding can ever charge |
| `funding_k_bps` | 50,000 |
| `max_stale_secs` | 3,600 — a mark older than an hour can never be accepted |
| `max_posted_slot_age` | 9,000 slots, about an hour |
| `max_bell_lead_secs` | 3,600 |
| `max_conf_bps` | 2,000 |
| `max_move_bps` | 9,000, and never zero |
| `max_carry_delta_bps` | 2,000 |
| `fill_incentive_bps`, `incentive_ramp[]` | 500, and the ramp must be non-decreasing |
| `max_premium_bps` | 5,000 |
| `auction_secs` | 30–3,600 |

A value outside any of these fails with `BadParameter` and the vault keeps the
parameters it had.

## 4. The curator

`curate` flips one boolean on a vault's `Listing`, and the desk's key holds it.
It decides whether a vault appears in the catalog by default. It does **not**
decide whether the vault works: an uncurated vault mints, settles, funds and
redeems exactly the same, and `initialize_vault` takes no permission from
anyone. The curator is an editorial position, not a gate, and the catalog says
"curated" rather than "verified" for that reason.

## 5. The detector authority

Event-session vaults only. It posts the issuer's mark and the executable price
for an asset no oracle covers — see `docs/JUDGE.md`, "Where it rests on
somebody's word". The program bounds how stale a reading may be, records who
posted it, and refuses to settle on one it cannot trust; it cannot make the
reading true. `/markets/OPENAI` says so in its own footer, above the fold.

---

## What "gave up the rug" would mean here

Not a promise — a sequence, with what each step costs and what it forecloses.
None of it has happened; the program is on devnet and this is the plan it
would have to follow before it held anything.

1. **Publish a verifiable build.** `solana-verify` against this repository at a
   tagged commit, so the bytes on chain can be matched to the source anyone can
   read. Costs nothing but is worthless without step 3.
2. **Move the upgrade authority to a multisig** (Squads), with the members
   named on this page. This does not remove the risk in §1 — it splits it, and
   the honest description is "several people can take it" rather than "nobody
   can".
3. **Set the authority to `None`.** One transaction, irreversible, and after it
   the program can never be fixed — including for a bug found later. This is
   the only step that actually retires §1, and it is a real trade, not a
   formality. The precondition is an audit this project has not had.
4. **Hand each vault's authority to the same multisig**, or to `None` once the
   recap path has been exercised on a live missed boundary. `resolve_halt` is
   the one place an operator's judgement still enters the accounting, and it
   should not be a single key by then.

The costs that gate all of it are in `docs/PHASE-F.md`: mainnet rent for this
854,600-byte program is **5.95 SOL** settled and **11.9 SOL** peak during the
deploy, before a share of inventory, against a wallet holding 0.25. Until then the honest statement is the one at the top: there is a
key, it is a single key, and it can take everything.

---

`docs/OPERATIONS.md` is the runbook for the powers above.
`docs/AUDIT.md` is the adversarial record, including the findings that were
wrong. `docs/JUDGE.md` is the ninety-second path.
