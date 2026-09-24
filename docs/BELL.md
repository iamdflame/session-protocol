# The bell oracle

`programs/session-bell` keeps the NYSE open and close as Pyth Pro prints. For each listing and each trading day there is one print for the 09:30 open and one for the 16:00 close (13:00 on the three scheduled half-days). Each print is taken from a Pyth-signed message. A Pyth verifier checked the message's signature in the same transaction, and a written rule accepted the price (`docs/METHOD.md`).

It is the price a bell order will settle on. So every part of it can be checked after the fact, without trusting whoever posted it or this repository's servers.

- **Anyone may post.** Whoever holds a better message can replace the stored print until its deadline.
- **At the deadline the print freezes.** Anyone may then finalise it, or mark the bell missing if nothing qualified. Neither can be undone.
- **The program holds no funds.** It stores prices.

## Where it runs

| | |
|---|---|
| Program | `BeLLKXJwhSH6YXYQLc8xLd11GxJUvoaT1h9zCadymJv4` (devnet) |
| Config | `EsDs2dRa1wP17tqq9BLMavYcvpgbHWBHTcB3zc5ckzew` |
| Verifier | `CVuKQFLc1PAuJ8y7kPckw8Hi8W6WhdeWrhM9UBVdm2qs`: Pyth's Lazer program built under a devnet id ([`tools/lazer-devnet`](../tools/lazer-devnet/README.md)) |
| Test signer | `5knAYu8dq3gH9wyuXY3dUuupSy2MTNnLrgXsb5vTwNXr`, trusted by that verifier until 24 Sep 2027 |
| Listings | NVDA, SPY, TSLA, AAPL, QQQ |
| Explorer | the site's `/oracle` page (`web/src/pages/Oracle.tsx`) |

**Every devnet print is simulated, and says so.** Pyth's own Lazer program, `pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt` on mainnet and devnet alike, trusts only Pyth's signers, and SESSION has no Pyth Pro key yet. So devnet verifies through a copy of Pyth's code that trusts a test key, and the prices come from Jupiter rather than Pyth ([`keeper/src/bell-poster.ts`](../keeper/src/bell-poster.ts)).

The program itself sets `simulated` on the config whenever the verifier is not Pyth's program id. Every print copies it into its `flags`, and nothing can clear it. Pointing the config at Pyth's program (`set_verifier`) is the whole switch to real prints. From then on, new prints are not flagged, and the old ones keep their flag.

## How a price gets in

A post is one transaction, in this order:

```
[compute budget]        optional
Ed25519 instruction     index e; Pyth's createEd25519Instruction(message, e + 1, 12)
post_print              index e + 1
```

`post_print`'s data puts the Pyth message at a fixed place:

```
disc[8] | u32 len | message[len] | day i64 | kind u8 | ed25519_ix u16
                    ^ byte 12
message = u32 2182742457 | signature[64] | public key[32] | u16 payload len | payload
```

The Ed25519 instruction therefore reads its signature at byte 16 of the post, the key at 80 and the payload at 114. All three offsets name the post's own instruction index. The Ed25519 precompile checks that signature over the payload when its instruction executes, just before the post's; if it fails, the whole transaction fails.

`post_print` then does, in order:

1. **Is there a bell?** `kind` must be 0 (open) or 1 (close). `day` is an Eastern-time day number, and it must be a trading day between 2020 and 2200 in `session-core`'s calendar (`NoBell`). The bell must not predate the listing's last activation (`NotListedAtBell`).
2. **Is posting open?** An existing print must still be provisional (`PrintClosed`). It is judged by the window and deadline it opened with. Now must be before that deadline (`PostingClosed`).
3. **Read it, and apply the rule, before paying for verification.** The message and payload are parsed exactly (`BadMessage`, `BadPayload`), and the listing's equity feed must be present (`FeedMissing`). Then `rules::accept` runs (`MissingProperty`, `NonPositivePrice`, `BadExponent`, `TooFewPublishers`, `NotRegularSession`, `ConfidenceTooWide`, `OutsideWindow`, `FeedAfterMessage`). A price dated more than 120 s past the chain's clock is refused (`FeedFromTheFuture`). An existing print is replaced only by a strictly later close or a strictly earlier open (`NotBetter`).
4. **Ask the verifier.** A CPI into `verify_message(message, ed25519_ix, 0)`. Pyth's code, unchanged in the devnet copy:
   - charges its fee (1 lamport) to the poster;
   - requires the Ed25519 instruction to precede the post and to hold nothing but offset records;
   - requires the message to sit in the post's own data exactly where those offsets say;
   - requires every offset to point at the post itself;
   - requires the signer to be trusted and unexpired.

   It returns `VerifiedMessage { public_key, payload }`.
5. **Bind the parse to what was verified.** The program reads that return data and requires it to come from the configured verifier (`NoVerification`). The key and payload must equal its own parse byte for byte (`VerificationMismatch`). The stored price is the price that was signed.
6. **Write.** The print holds:
   - the equity quote: price, confidence, exponent, publishers, session, and the feed's own update time;
   - the redemption rate, token and 24/7 index quotes from the same message;
   - the token's gap from redemption value in basis points, with a flag beyond `max_divergence_bps`;
   - who signed, which program verified, who posted, and when.

A post costs about 72,000–75,000 compute units: 74,584 in the LiteSVM harness, and 72,085 in the devnet rehearsal.

## Accounts

All fixed-size. The byte layout the SDK decodes is pinned by [`tests/vectors/print-account.json`](../tests/vectors/print-account.json), which the program's own serializer writes.

| Account | Seeds | Size | Holds |
|---|---|---|---|
| `BellConfig` | `["bell-config"]` | 195 | admin and pending admin, verifier and its storage, `simulated`, the rule's parameters |
| `Listing` | `["listing", symbol[16]]` | 139 | the four Pyth Pro feed ids (equity required, the others optional), the xStock mint, counts, `active`, `active_since` |
| `Print` | `["print", listing, day i64 LE, kind u8]` | 378 | the print; rent 0.00257 SOL, paid by whoever opens it |

`Print`, after its 8-byte discriminator:

| Offset | Field | |
|---|---|---|
| 8 | `version`, `bump`, `status`, `kind`, `flags`, `channel` | u8 each. Status 0 provisional, 1 final, 2 missing. Flags 1 simulated, 2 divergence known, 4 divergent |
| 14 | `posts`, `method_version` | u16 each |
| 18 | `listing` | memcmp here to list one symbol's prints |
| 50 | `day`, `bell_ts`, `window_start_us`, `window_end_us`, `deadline` | the window a price had to come from, fixed when the print opened |
| 90 | `equity`, `rr`, `token`, `index` | 34 bytes each: feed id u32, price i64, conf i64, expo i16, publishers u16, session u8 (255 unreported), present u8, feed time µs u64 |
| 226 | `divergence_bps`, `message_ts_us` | i64, u64 |
| 242 | `signer`, `verifier`, `poster` | 32 bytes each |
| 338 | `slot`, `posted_at`, `finalized_at` | |

## Instructions

| Instruction | Who | |
|---|---|---|
| `init_config(params)` | the program's upgrade authority, once | the config chooses which signatures count, so nobody else may create it |
| `set_params(params)` | admin | bounded (`Params::valid`); a print already open keeps its window and deadline |
| `set_verifier()` | admin | `simulated` follows the verifier and cannot be set |
| `transfer_admin` / `accept_admin` | admin, then the new admin | two steps, so a typo cannot orphan the config |
| `register_listing(symbol, feeds…, mint)` | admin | the equity feed is fixed from then on |
| `set_listing_active(active)` | admin | bells that pass while it is off belong to nobody |
| `post_print(message, day, kind, ed25519_ix)` | anyone | above |
| `finalize_print()` | anyone, from the deadline | provisional → final |
| `mark_missing(day, kind)` | anyone, from the deadline | creates a `Missing` print where none exists; the account's creation is the check |

Every state change emits an event: `PrintPosted`, `PrintFinalized`, `PrintMissing`, and so on.

## Check a print yourself

1. Read the print account (`getAccountInfo`, or `getProgramAccounts` with the `Print` discriminator and a memcmp on the listing at offset 18). Decode it with `decodePrint` from [`sdk/src/bell.ts`](../sdk/src/bell.ts), or by the table above.
2. `flags & 1` says whether a test signer was involved. `verifier` names the program that vouched for `signer`.
3. List the account's transactions. The one that last wrote it holds the Ed25519 instruction, then `post_print` with the message at byte 12, and a CPI into `verify_message`. Its logs end in `PrintPosted`.
4. Re-verify the message offline. The payload is at byte 102 of the message and the signature at byte 4. Check it against `signer` with any Ed25519 library, then re-read the price with `parseLazerPayload`.

## What holds it to Pyth

- **Pyth's encoder.** [`tests/vectors/lazer.json`](../tests/vectors/lazer.json) was written by `pyth-lazer-protocol` 0.46.0 itself. Its expected fields come from what went into the encoder. Both the program's parser and the SDK's must read all 8 valid messages to exactly those fields, and refuse all 19 broken ones with the named error.
- **Pyth's verifier.** [`tests/integration`](../tests/integration) runs the program in LiteSVM next to Pyth's Lazer binary, dumped from mainnet by `fetch.sh`. It uses Pyth's own `initialize` and `update`. 19 cases pass. They cover the attack where a signature over one message is offered for another: Pyth refuses the Ed25519 instruction that carries it, and refuses it again, padded past that check, for pointing at the wrong instruction. The same 19 pass against the devnet copy of the verifier.
- **Pyth's calendar.** `tests/pyth-schedule.check.ts` holds the program's calendar against the regular session Pyth publishes for each listing: 2,114 listing-days, no disagreement.

## Known limits

- **Devnet is simulated** (above). The live Pyth Pro path in the poster is written against `@pythnetwork/pyth-lazer-sdk` 7 and has not run.
- **The devnet binary predates `FeedFromTheFuture`.** An upgrade needs about 2.3 SOL of temporary buffer, and the devnet faucet has been rate-limiting. Until then the devnet program would accept a future-dated message from its test signer. The poster never sends one, and every print's `posted_at` sits beside its feed time on `/oracle`.
- **The multiplier cross-check is not built.** The divergence recorded is `(token − equity × rr) / (equity × rr)` from Pyth's own feeds. Checking `rr` against the xStock's scaled-UI multiplier waits for Phase 2, which has to settle what one raw token is worth first. Simulated prints carry no `rr` at all, because Jupiter's multiplier is not shown to be the quantity Pyth's `.RR` feed carries.
- **The bell price is Pyth's aggregate at the bell, not the exchange's official open or close.** How far apart those are is what `docs/METHOD.md`'s calibration measures.
