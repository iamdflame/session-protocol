# SESSION technical video: script (target 4:40, hard limit 5:00)

**Voice:** the same voice and settings as the pitch. Generate one file per scene and name it after the scene (`T01.wav` … `T09.wav`); the clips are `demo/out/technical/T01-….mp4`. Code names are spelled for the voice in the ElevenLabs versions.

Each scene has two voiceover versions:
- **Caption** is what viewers read.
- **ElevenLabs** is what you paste.

---

## T01 · What this is (0:00–0:16)

**Picture:** the title "SESSION · how it works"; the architecture diagram starts drawing itself.

**Caption:** This is the engineering behind SESSION: orders that fill at the NYSE open or close, at a price verified on-chain. Two programs, a shared core, one keeper, and receipts anyone can check.

**ElevenLabs:**
```
This is the engineering behind SESSION. Orders that fill at the N-Y-S-E open or close, at a price verified on-chain. Two programs, a shared core, one keeper... and receipts anyone can check.
```

## T02 · Architecture (0:16–0:44)

**Picture:** the full diagram:
- the poster → `session-bell` (the oracle; holds no funds) → prints;
- traders, the Blink and agents → `session-cross` (escrow, pricing, auction, settlement);
- `session-core` shared by both;
- the keeper, cranking;
- the site reading everything.

**Caption:** The bell oracle, session-bell, only keeps prints: it never holds funds. The exchange, session-cross, holds the escrow and does the pricing, the auction and settlement. Both share one Rust core for the calendar and the arithmetic. Every step after placing an order is permissionless. The keeper is a convenience, not an authority.

**ElevenLabs:**
```
The bell oracle, session-bell, only keeps prints. It never holds funds. The exchange, session-cross, holds the escrow, and does the pricing, the auction, and settlement. Both share one Rust core, for the calendar and the arithmetic. Every step after placing an order is permissionless. The keeper is a convenience... not an authority.
```

## T03 · How a print gets in (0:44–1:26)

**Picture:** `PostPrintAnatomy`:
- instruction 0 is the Ed25519 precompile, with its offsets pointing into instruction 1;
- instruction 1 is `post_print`, with the message starting at byte 12;
- the CPI into the verifier, then "trusted signer · not expired";
- then the rule card;
- a real devnet `post_print` transaction on the explorer.

**Caption:** A print arrives as one transaction. Instruction zero is Solana's Ed25519 precompile, and its offsets point at our instruction, where the signed message starts at byte twelve. The program hands that message to Pyth's verifier, which checks the signer is trusted and unexpired, and then parses every byte itself. The close is the last price in the seconds before 4 PM; the open is the first after 9:30. Regular session only, tight confidence, strictly better prices replace worse ones, and a price stamped in the future is refused.

**ElevenLabs:**
```
A print arrives as one transaction. Instruction zero is Solana's ed-twenty-five-five-nineteen precompile... and its offsets point at our instruction, where the signed message starts at byte twelve. The program hands that message to Pith's verifier, which checks the signer is trusted and unexpired. Then it parses every byte itself. The close is the last price in the seconds before four P.M. The open is the first after nine thirty. Regular session only. Tight confidence. Strictly better prices replace worse ones. And a price stamped in the future is refused.
```

## T04 · The cross (1:26–2:18)

**Picture:**
- the state machine: collecting → frozen (T−2 min) → priced → confirming → auction (2 min) → cleared → settling → closed;
- then `ClearingMath`: X per raw token = print × multiplier; buyers and sellers net at X; the crowded remainder meets a 101-step fee ladder; the marginal bucket is rationed;
- the rounding rule.

**Caption:** Orders collect in escrow until two minutes before the bell, then the book freezes. Once the print is final, the cross prices one raw token at the print times the mint's own multiplier, read from its Token-2022 extension. It cancels instead if the multiplier changes near the bell. Buyers and sellers net at that price. The larger side's remainder goes to a two-minute auction on a 101-step fee ladder. The clearing fee is the lowest ask that covers the need, and the last bucket is rationed. Everything consumed rounds up and everything received rounds down, so the escrow can never pay out more than it holds.

**ElevenLabs:**
```
Orders collect in escrow until two minutes before the bell. Then the book freezes. Once the print is final, the cross prices one raw token at the print, times the mint's own multiplier, read from its Token twenty-twenty-two extension... and it cancels instead, if the multiplier changes near the bell. Buyers and sellers net at that price. The larger side's remainder goes to a two-minute auction, on a one-hundred-and-one-step fee ladder. The clearing fee is the lowest ask that covers the need, and the last bucket is rationed. Everything consumed rounds up. Everything received rounds down. So the escrow can never pay out more than it holds.
```

## T05 · The tests (2:18–3:02)

**Picture:** real terminal output, rendered from captured runs:
- the Rust property tests at 10,000 cases each;
- the LiteSVM suites: 19 bell cases, and 9 cross cases on the real NVDAx mint with Pyth's real verifier binary;
- the fuzz summary: 300 crosses across more than a year of trading days;
- the cross-language vectors;
- the browser flow checking devnet to the atom.

**Caption:** The arithmetic is property-tested, ten thousand cases a property. The programs run in LiteSVM against the real NVIDIA token, captured from mainnet at its real address, and prices verified by Pyth's real verifier binary: 19 oracle cases, 9 exchange cases. A fuzzer runs 300 random crosses across more than a year of trading days, and every balance must match the math to the atom. The TypeScript SDK decodes the very bytes the Rust wrote. And a headless browser places real orders on devnet and checks every atom.

**ElevenLabs:**
```
The arithmetic is property-tested: ten thousand cases, a property. The programs run in Lite-S-V-M against the real NVIDIA token, captured from mainnet at its real address... with prices verified by Pith's real verifier binary. Nineteen oracle cases. Nine exchange cases. A fuzzer runs three hundred random crosses, across more than a year of trading days, and every balance must match the math, to the atom. The TypeScript S-D-K decodes the very bytes the Rust wrote. And a headless browser places real orders on devnet, and checks every atom.
```

## T06 · Failure, live (3:02–3:38)

**Picture:** the drill record from today's open (real signatures, explorer cut-ins):
- pause: the mint paused, the cross clears, quote legs paid while the tokens are held, resumed, tokens settled, escrow reads 0;
- multiplier: the new multiplier scheduled for 13:35, then `price_cross` emits "cancelled: multiplier activation near the bell", refunds, escrow reads 0.

**Caption:** Failure modes run in public, at a real bell. We paused an NVIDIA-shaped token before the open. The cross still priced and cleared, the keeper paid every quote leg alone, and the tokens waited until the issuer resumed. On a second token we scheduled a new multiplier five minutes after the bell, and pricing refused to guess: it cancelled and refunded everyone, whole. Both escrows read zero.

**ElevenLabs:**
```
Failure modes run in public, at a real bell. We paused an NVIDIA-shaped token before the open. The cross still priced and cleared. The keeper paid every quote leg alone... and the tokens waited, until the issuer resumed. On a second token, we scheduled a new multiplier five minutes after the bell... and pricing refused to guess. It cancelled, and refunded everyone, whole. Both escrows read zero.
```

> **Not needed: both drills passed at the 25 Sep open**; use the line above. Kept only for a re-run that fails:
> ```
> Failure modes are tested against the real NVIDIA token. An issuer pause holds the tokens but never the refunds. A multiplier change near the bell cancels the cross and refunds everyone, whole. A missing print cancels too. We ran the same drills on devnet at today's open, and the record shows every step.
> ```

## T07 · The keeper, and the counterfactual (3:38–4:04)

**Picture:**
- the keeper's journal lines from today: priced with its counterfactual, cleared, settled;
- the `price_cross` transaction on the explorer, showing the Memo `session-cross counterfactual v1 {…}`;
- the receipt's "Against a swap" section.

**Caption:** At the bell, the keeper quotes both sides of the cross on Jupiter, for the real NVIDIA token on mainnet, and writes the quotes into the very transaction that prices the cross. A receipt shows that comparison only from that transaction, and only if the keeper named in the manifest signed it. Anyone else's memo is ignored.

**ElevenLabs:**
```
At the bell, the keeper quotes both sides of the cross on Jupiter, for the real NVIDIA token on mainnet... and writes the quotes into the very transaction that prices the cross. A receipt shows that comparison only from that transaction, and only if the keeper named in the manifest signed it. Anyone else's memo is ignored.
```

## T08 · Agents and Blinks (4:04–4:24)

**Picture:**
- an agent session: `bell_status`, `bell_quote` ("at the bell vs a swap now"), `bell_place_order` refused over the cap, then placed at $3, then cancelled;
- the Blink card, and its transaction.

**Caption:** Agents get five MCP tools: status, quote, receipt, place and cancel. The two that write are capped per order in code and refused on mainnet unless a flag says otherwise. A Blink builds the same order for whoever clicks. It checks the balance before asking for a signature, and holds no key.

**ElevenLabs:**
```
Agents get five M-C-P tools: status, quote, receipt, place, and cancel. The two that write are capped per order, in code... and refused on mainnet, unless a flag says otherwise. A Blink builds the same order for whoever clicks. It checks the balance before asking for a signature, and it holds no key.
```

## T09 · Check it yourself (4:24–4:42)

**Picture:**
- a receipt page, then its print transaction on the explorer (instruction 0 is Ed25519), then the pricing transaction's memo;
- the end card: repo URL, program IDs, "Don't trust the page. Check the chain."

**Caption:** Don't take the page's word for any of it. Every receipt links the print's transaction, its signature check, and the memo beside the price. The programs, the keeper and the tests are open source. Check the chain.

**ElevenLabs:**
```
Don't take the page's word for any of it. Every receipt links the print's transaction, its signature check, and the memo beside the price. The programs, the keeper, and the tests are open source. Check the chain.
```

---

## Claims and their sources

| Claim | Source |
|---|---|
| The oracle holds no funds | `programs/session-bell`: no token accounts; prints only (`docs/BELL.md`) |
| Ed25519 at instruction 0, message at byte 12, CPI `verify_message` into Pyth's Lazer contract | `programs/session-bell/src/lib.rs`, `sdk/src/bell.ts` `POST_PRINT_MESSAGE_OFFSET = 12` |
| Close = last price in the seconds before 16:00; open = first after 09:30 | Rule v1: 10 s close lead and 60 s open window. Devnet widens these to 180 s and 300 s, because the simulated source refreshes every 1–2 min (`docs/METHOD.md`) |
| Regular session, confidence ≤ 25 bp, strict replacement, `FeedFromTheFuture` | `programs/session-bell/src/rules.rs` (`MAX_CLOCK_LEAD_SECS = 120`) |
| Freeze at T−2 min; 2-min auction; 101-bucket ladder; marginal rationing; rounding | `programs/session-cross`, `crates/session-core/src/cross.rs`, `docs/CROSS.md` |
| Multiplier guard | `price_cross`: an activation within 900 s of the bell, or after it before pricing, cancels |
| Property tests at 10,000 cases | `crates/session-core/src/cross.rs` (`ProptestConfig::with_cases(10_000)`) |
| 19 bell and 9 cross LiteSVM cases, on the real NVDAx bytes and Pyth's mainnet verifier binary | `tests/integration/tests/{bell,cross}.rs`, `tests/integration/fetch.sh` |
| 300-cross fuzz over more than a year of trading days | `tests/integration/tests/cross_fuzz.rs` (`CROSS_FUZZ=300`, `docs/CROSS.md`) |
| The SDK decodes the bytes Rust wrote | `tests/vectors/*.json`, `tests/cross-ix.test.ts` |
| The browser checks devnet to the atom | `web/scripts/bells-flow.mjs` |
| Drills at today's open | `web/public/cross-drills.json` (filled in after the bell) |
| Counterfactual memo; trusted only from the pricing transaction the named keeper signed | `sdk/src/counterfactual.ts`, `sdk/src/receipt.ts`, `tests/receipt.test.ts` |
| Five MCP tools; writes capped; mainnet refused without a flag | `agent/mcp.ts`, `agent/mcp-check.ts` |
| The Blink checks the balance and holds no key | `web/api-src/bell-action.ts`, `web/scripts/actions-check.mjs` |
