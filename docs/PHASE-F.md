# What mainnet costs, and what it buys

Everything on this page is specified and not built, for one reason: it costs
more than this project has. The rule the whole plan was built under is that
any mainnet action over **1 SOL** is deferred rather than faked, so this is
the list of things on the far side of that line, each with the number that
puts it there.

Prices below are live at the time of writing: **1 SOL ≈ $116.19**,
**NVDAx ≈ $223.68**. The mainnet wallet holds **0 SOL**. It held 0.2508 after
the `$BELL` launch and holds nothing now, which does not change the argument
— 0.25 SOL and 0 SOL are the same distance from the 11.90 this needs — but a
document whose entire point is the gap between a balance and a cost should
not be reporting the balance from memory. That figure is the whole reason this
document exists rather than a deployment.

---

## The floor: getting the program onto mainnet at all

The artifact is **854,600 bytes**. Solana charges rent-exemption at 3,480
lamports per byte-year over a two-year threshold, plus 128 bytes of account
overhead, so:

| Account | Bytes | Rent-exempt |
|---|---|---|
| Program data (45 + the `.so`) | 854,645 | **5.949 SOL** |
| Program account | 36 | 0.001 SOL |
| Deploy buffer (refunded on success) | 854,637 | 5.949 SOL |
| **Peak balance required** | | **≈ 11.90 SOL** (≈ $1,383) |
| **Settled cost after the buffer closes** | | **≈ 5.95 SOL** (≈ $691) |

An earlier version of this figure said 3.7 SOL. That was true when the program
was about 530 KB; Phases A and B added the recap path, the auction, the
issuer inspector, the event session and the registry, and it is now 0.85 MB.
The number moved because the program did, which is the kind of thing a stale
figure hides.

This buys nothing on its own. It is the cost of the cluster.

## The instance: making it actually NVDA

| Item | What it costs | What it unlocks |
|---|---|---|
| Hermes key, posting `Crypto.NVDAx/USD` and keeping `Equity.US.NVDA/USD` fresh | a key, plus ≈3 SOL of posting over a quarter | the mark is the asset, not `Crypto.SOL/USD` standing in for it |
| Vault inventory in real NVDAx | 1 share ≈ $223.68; a book worth quoting is 50–100 shares, so **$11k–$22k** | real custody — and real exposure to the issuer powers the instrument card already lists |
| USDC quote inventory | matched to the above | redemptions that do not depend on a filler arriving |
| Mainnet DAMM v2 depth for `NVDA.DAY`, LP locked | inventory, plus ≈0.2 SOL of accounts | DAY is exitable at size while it is the parked class |
| Kamino or similar on idle parked quote | integration, gas, and a new counterparty risk | a yield story that is **not** the wedge and should not be led with |
| Confidential-transfer path | NVDAx carries the extension; proving delivery-versus-payment under it is its own product | a settlement mode, later |
| A second and third name | inventory × N | the venue rather than the instrument |

## What is deliberately not here

- **A resolution-session product.** It is a different mint, a different
  program instance and a different repository. Carrying a second pre-IPO token
  in this tree would disqualify the PreStocks entry outright — see
  `docs/BOUNTIES.md`.
- **A basket.** `Mag7.DAY` is one line in the catalog and no code, and stays
  that way until five equity vaults exist. A basket over one vault is a
  rename.
- **Retiring the upgrade authority.** That is step 3 of
  `docs/UPGRADE-POLICY.md`, it is irreversible, and its precondition is an
  audit this project has not had. It is not cheap-because-it-is-one-
  transaction; it is the most expensive item on either list.

## What was done on mainnet, and for how much

Not nothing — the line is at 1 SOL, not at zero.

| Action | Cost |
|---|---|
| `$BELL` launched via Clawpump, curve denominated in **real NVDAx** | 0.009223 SOL |
| Remaining balance, at the time this document was first written | 0.2508 SOL |
| Remaining balance, checked again on 2026-09-22 | **0 SOL** |

The `$BELL`/NVDAx DAMM v2 pool specified in the plan was **not** created, and
the reason is in `docs/BOUNTIES.md`: the pump.fun bonding curve the launch
already produced *is* a pool quoted in the stock, so a second thin pool beside
it would have been a worse market wearing the same claim.

---

Until every line above is paid for, every surface says **devnet**,
**stand-in feeds** and **Token-2022-shaped underlying**, in one line, above
the fold. A pre-mainnet product is allowed. A pre-mainnet product that reads
like a live one is not.
