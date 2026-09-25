# SESSION pitch video: script (target 2:50, hard limit 3:00)

**Voice:** calm and confident, unhurried, never salesy. Generate one ElevenLabs file per scene and name it after the scene (`P01.wav` … `P09.wav`); the video clips carry the same numbers (`demo/out/pitch/P01-hook.mp4` …). Settings are in `ELEVENLABS.md`.

Each scene has two voiceover versions:
- **Caption** is what viewers read.
- **ElevenLabs** is what you paste, with numbers written out and names spelled for the voice.

The timings are targets at the recommended speed. Your audio sets the final ones, and the clips run a little long so you can trim.

---

## P01 · Hook (0:00–0:14)

**Picture:** a city at night, then the 168-hour week as a bar with five short days lit, then the stat card "63% of tokenized-stock volume trades outside US market hours", with its source.

**Caption:** NVIDIA's price is made six and a half hours a day. On Solana, its token trades all 168 hours of the week… and 63% of that volume happens while the price isn't being made.

**ElevenLabs:**
```
NVIDIA's price is made six and a half hours a day. On Solana, its token trades all one hundred and sixty-eight hours of the week... and sixty-three percent of that volume happens while the price isn't being made.
```

## P02 · The cost (0:14–0:33)

**Picture:**
- stat cards: weekend pool deviation 22–31 bp against about 3 bp on weekdays; round trip at $10k, NVDAx 9.9 bp and METAx 126 bp;
- a live "Now, on Jupiter" quote from the ticket.

**Caption:** Those are the hours pools are thinnest. Over a weekend, prices drift about eight times further from the stock than on a weekday, and for some names a round trip costs over one percent. You pay for the noise.

**ElevenLabs:**
```
Those are the hours pools are thinnest. Over a weekend, prices drift about eight times further from the stock than on a weekday... and for some names, a round trip costs over one percent. You pay for the noise.
```

## P03 · Ade, Saturday night (0:33–0:57)

**Picture:**
- a phone at night;
- the `/bells` ticket, typing $200 with "Now, on Jupiter" beside "At the bell";
- the tap, the wallet signing, the confirmation, the order in "Your orders".

Lower third: *Devnet sandbox · fixture NVDAx · test USDC*.

**Caption:** Meet Ade. Saturday night in Lagos, and she wants $200 of NVIDIA. SESSION shows both choices: swap now on Jupiter, or buy at Monday's open. She picks the bell. One signature, and her dollars wait in escrow, cancellable until two minutes before the open.

**ElevenLabs:**
```
Meet Ade. Saturday night in Lagos, and she wants two hundred dollars of NVIDIA. SESSION shows both choices: swap now, on Jupiter... or buy at Monday's open. She picks the bell. One signature, and her dollars wait in escrow, cancellable until two minutes before the open.
```

## P04 · The bell (0:57–1:25)

**Picture:**
- a countdown to 09:30 ET, then the bell rings (sound effect);
- the print lands, with the chips "signed" and "verified on-chain";
- the netting animation: buyers and sellers meet, and makers fill the leftover;
- real footage of today's print arriving on `/oracle`, with the SIMULATED SIGNER chip visible.

**Caption:** Monday, 9:30 in New York. The Bell oracle posts NVIDIA's opening print, and the program verifies its signature on-chain, with Pyth's own verifier code. Everyone in the cross trades at that one price. Buyers and sellers net for free, and market makers fill whatever is left, at a fee the backstop caps.

**ElevenLabs:**
```
Monday. Nine thirty, in New York. The Bell oracle posts NVIDIA's opening print... and the program verifies its signature on-chain, with Pith's own verifier code. Everyone in the cross trades at that one price. Buyers and sellers net for free... and market makers fill whatever is left, at a fee the backstop caps.
```

## P05 · The receipt (1:25–1:49)

**Picture:** the real receipt of today's open cross (`/b/…`):
- the price;
- the three checks marked passed: "Signature checked again in this browser";
- what each side got;
- "Against a swap at the same moment", with its basis points.

Slow camera moves over each part.

**Caption:** Then, the receipt. The price, and the print behind it, its signature checked again right in your browser. What each side put in and got back. And beside it, what Jupiter would have given at that moment, because a saving you can't check isn't a saving.

**ElevenLabs:**
```
Then, the receipt. The price, and the print behind it... its signature checked again, right in your browser. What each side put in, and got back. And beside it, what Jupiter would have given, at that moment. Because a saving you can't check... isn't a saving.
```

## P06 · Trust (1:49–2:11)

**Picture:** the drill record from today's open, as a clean animated checklist:
- pause: "quote legs paid while paused", then "tokens held", then "resumed", then "escrow 0 · passed";
- multiplier: "cancelled: multiplier activation near the bell", then "refunded whole", then "escrow 0 · passed";
- then "300 random crosses · every balance to the atom".

**Caption:** Tokenized stocks come with issuer powers, so we drilled them at a real bell. A pause held the tokens but never the refunds. A multiplier change cancelled the cross and refunded everyone, whole. Both escrows ended at zero. And across 300 random crosses, every balance matched, to the atom.

**ElevenLabs:**
```
Tokenized stocks come with issuer powers. So we drilled them, at a real bell. A pause held the tokens... but never the refunds. A multiplier change cancelled the cross, and refunded everyone, whole. Both escrows ended at zero. And across three hundred random crosses, every balance matched, to the atom.
```

> **If a drill does not pass today**, use this instead. I'll tell you by 14:15 UTC which applies:
> ```
> Tokenized stocks come with issuer powers, so we test for them. In the program's own test suite, on the real NVIDIA token, an issuer pause holds the tokens but never the refunds, and a multiplier change cancels the cross and refunds everyone, whole. And across three hundred random crosses, every balance matched the math, to the atom.
> ```

## P07 · Why Solana (2:11–2:31)

**Picture:**
- the Ed25519 instruction and the verify call inside one transaction on the explorer;
- "one instruction clears the whole book";
- the token's multiplier read on-chain;
- the Blink card;
- an agent terminal calling `bell_quote`.

**Caption:** It belongs on Solana. Signatures verified inside the same transaction. One instruction clears the whole book, whatever its size. Token multipliers read on-chain, so a token's price always matches the share. And it travels: a Blink on X, or an AI agent with its limits in code.

**ElevenLabs:**
```
It belongs on Solana. Signatures, verified inside the same transaction. One instruction clears the whole book, whatever its size. Token multipliers, read on-chain, so a token's price always matches the share. And it travels: a Blink on X... or an A.I. agent, with its limits written in code.
```

## P08 · Where it stands (2:31–2:47)

**Picture:**
- a status panel: "Live on devnet since 25 Sep: bell oracle · 5 listings · the cross · receipts · Blink · agent tools";
- the path ahead: "Pyth Pro key → audit → mainnet, with caps".

**Caption:** Today it runs on devnet, at the real New York bells, with a test signer standing in for Pyth until our Pyth Pro key arrives. Next: an audit, then mainnet, with caps.

**ElevenLabs:**
```
Today, it runs on devnet, at the real New York bells, with a test signer standing in for Pith... until our Pith Pro key arrives. Next: an audit. Then mainnet, with caps.
```

## P09 · End card (2:47–2:55)

**Picture:** the SESSION mark; "Trade at the bell."; `session-roan.vercel.app`; `github.com/iamdflame/session-protocol`. The bell sound effect lands on the logo.

**Caption:** SESSION. Trade at the bell.

**ElevenLabs:**
```
SESSION. Trade at the bell.
```

---

## Claims and their sources

| Claim | Source |
|---|---|
| The price is made 6.5 hours a day; the token trades all 168 hours a week | NYSE regular session 09:30–16:00 ET; xStocks trade continuously on Solana |
| 63% of tokenized-equity volume trades outside US market hours | Solana Foundation newsletter / Crypto Briefing, through Aug 2026 (MASTERPLAN §3) |
| Weekend pool deviation "about eight times" weekday | bozBasket, 18–20 Sep 2026: 22 / 31 bp median against 2.7 / 3.5 bp (8.1× and 8.9×) |
| "For some names a round trip costs more than one percent" | Haircut, 14 Sep 2026: METAx 126.4 bp at $10k during market hours |
| Signature verified on-chain with Pyth's own verifier code | `programs/session-bell` CPI into Pyth's Lazer contract 0.8.0, rebuilt for devnet (`tools/lazer-devnet`, `docs/BELL.md`) |
| Test signer on devnet | The config is flagged `simulated`; every page shows SIMULATED SIGNER |
| Cancellable until two minutes before the open | `freezeSecs: 120` (`web/public/cross-devnet.json`) |
| Fee capped by a backstop | The 15 bp backstop maker (`docs/CROSS.md`) |
| The receipt re-checks the signature in the browser, and the Jupiter comparison sits beside it | `/b/<cross>`, `sdk/src/receipt.ts`, `sdk/src/counterfactual.ts` |
| Drills at a real bell, escrows at zero | `web/public/cross-drills.json`, the 25 Sep 13:30 UTC open (checked after the bell) |
| 300 random crosses, every balance to the atom | `tests/integration/tests/cross_fuzz.rs` (`docs/CROSS.md`) |
| One instruction clears the whole book | `clear` works on the cross's aggregate totals and the 101-bucket ladder, O(1) in the number of orders |
| Blink and agent limits in code | `/api/bell-action`, and `agent/mcp.ts` (`AGENT_MAX_BELL_*`) |
