# SESSION: the Stocklana submission

Everything the submission form asks for, in the order it asks. The same text, without markdown and ready to paste, is in [SUBMISSION.txt](SUBMISSION.txt). Every figure below is on chain, in the repository, or sourced; the evidence index at the end links each one.

| Form field | What goes in it | Length |
|---|---|---|
| Project name | SESSION: Bell Orders for Tokenized Stocks | 41 |
| One-liner | below | 273 / 280 |
| Detailed description | below | 4822 / 5000 (markdown), 4751 / 5000 (plain) |
| GitHub | https://github.com/iamdflame/session-protocol | |
| Demo URL | https://session-roan.vercel.app/bells | |
| Video | https://youtu.be/fOLXfgxa3xg | |
| Bounty tracks | Pyth Network, PreStocks, Clawpump | 3 of 3 |

## Project name

**SESSION: Bell Orders for Tokenized Stocks**

If the field is short, use **SESSION**.

## One-liner

273 of 280 characters.

> Buy or sell tokenized stocks at any hour and get filled at the NYSE open or close, at the bell's Pyth price, verified on-chain. SESSION nets buyers and sellers at one price for everyone, makers clear the rest, and every fill gets a receipt with the Jupiter quote beside it.

## Detailed description

4822 of 5000 characters as markdown; 4751 as plain text. Paste this version only if the form renders markdown; otherwise use the plain block in SUBMISSION.txt.

---

**The opening and closing auction that tokenized stocks don't have.** Live on Solana devnet, at real NYSE bells.

#### The user and the problem
NVIDIA's price is made on Nasdaq 6.5 hours a day. NVDAx trades on Solana all 168 hours of the week, and 63% of tokenized-equity volume happens while US markets are shut (Solana Foundation). Those are the hours pools are thinnest: weekend pool deviation runs 22–31 bp, against 2.7–3.5 bp on weekdays (bozBasket, 18–20 Sep). Wall Street's answer is the auction at the bell; the closing auction alone is 8–15% of US daily volume. Tokenized stocks have none.

Ade in Lagos wants $200 of NVIDIA at Monday's open. It's Saturday night, and at 09:30 ET she'll be asleep. Today her only option is a thin weekend pool.

#### What we built
SESSION is **bell orders**. Place a buy or sell any time, and it fills at the NYSE open or close at the price the bell printed: one price for everyone in that bell.
- **session-bell, the oracle.** A print gets in only as a Pyth Lazer message. Solana's Ed25519 precompile checks its signature in the same transaction, and Pyth's verifier confirms the signer by CPI. A written rule then accepts the price: regular session, confidence ≤25 bp, a window around the bell, strictly better replacement. Final prints are immutable accounts any program can read. The oracle holds no funds.
- **session-cross, the exchange.** Orders sit in escrow until the book freezes 2 minutes before the bell. The cross prices a token at the print × the mint's own Token-2022 multiplier, and nets buyers against sellers at that price with no fee. The imbalance goes to a 2-minute uniform-price maker auction on a 101-step fee ladder, and a standing backstop caps the fee. A missing print, or a multiplier change near the bell, cancels the cross and refunds everyone whole. Rounding always favours the escrow, and every step after placing an order is permissionless.
- **A receipt for every cross.** It re-checks the print's signature in your browser, and shows what a Jupiter swap would have given at that moment. The keeper writes that quote into the pricing transaction itself, and the receipt trusts it from nowhere else.
- **Three ways in:** the /bells ticket ("Now, on Jupiter" beside "At the bell"), a Solana Blink that places the order from a shared link, and 5 MCP tools for agents, their writes capped in code.

#### It ran at a real bell: the 25 Sep 2026 open
- All 5 prints (NVDA, SPY, TSLA, AAPL, QQQ) were posted and finalised. NVDA opened at **$225.82**, 16 s after 09:30 ET.
- The NVDA cross priced, cleared and settled 4 test orders and the maker's offer. Buyers paid $1,205 for 5.3326 NVDAx; sellers sold 3.0051 NVDAx for $678.61. Buyers were crowded, and paid the 15 bp fee only on the part makers filled.
- Against Jupiter at 09:30:03, sellers got **37.16 bp more** and buyers **33.99 bp less**. The pool was cheaper than the stock that morning, and the receipt says so.
- Issuer drills ran at the same bell. With the mint paused, quote legs were paid and the tokens waited for the resume. A multiplier change cancelled its cross and refunded everyone whole. Both escrows ended at zero.

Receipt: https://session-roan.vercel.app/b/GdN6aYz68FBYxmwjVVUbJ9PEXrsku5nsDj7S18uX7PAb

#### Try it in a minute
Open /bells, connect a devnet wallet, take test funds from the faucet, and place an order for the next real bell. Its receipt appears once the bell clears.

#### Execution
- LiteSVM on the real NVDAx mint bytes, captured from mainnet, with Pyth's real verifier binary: 19 oracle and 9 exchange cases.
- A fuzzer runs 300 random crosses across more than a year of trading days. Every balance matches the math to the atom, and every escrow ends empty.
- Property tests at 10,000 cases each; the TypeScript SDK pinned to the Rust by shared vectors; a headless browser that places real devnet orders and checks each against the chain.

#### Why Solana
- A native precompile checks Pyth's signature inside the transaction that stores the price.
- Token-2022 puts each xStock's multiplier on chain, so a token's price is read, not assumed.
- A whole bell settles at one price, in permissionless transactions costing a fraction of a cent.
- Tokenized stocks live here: 1M+ holders, 85–95% of on-chain activity. Blinks and agents meet users where they are.

#### What's real, and what's next
Devnet is a labelled sandbox: a fixture NVDAx with the real mint's extensions and multiplier, and test USDC. Prints are signed by a test key that a rebuild of Pyth's own verifier trusts, priced from Jupiter until we hold a Pyth Pro key. Each is flagged SIMULATED on chain, and pointing the oracle at Pyth's program is one instruction. On mainnet today: $BELL, launched through Clawpump and quoted in real NVDAx. Next: the Pyth Pro key, an audit, then mainnet with caps.

---

## Links

| Field | Link |
|---|---|
| GitHub | https://github.com/iamdflame/session-protocol |
| Demo URL | https://session-roan.vercel.app/bells |
| Video | https://youtu.be/fOLXfgxa3xg |

If the form takes more links:

- [The receipt from the 25 Sep open](https://session-roan.vercel.app/b/GdN6aYz68FBYxmwjVVUbJ9PEXrsku5nsDj7S18uX7PAb)
- [Every print, verified](https://session-roan.vercel.app/oracle)
- [$BELL on mainnet](https://solscan.io/token/7z9y4P3yatZki2AHHtzjPxEhjVTP1d362BQH1kDPdQTe)

## Bounty tracks

Select exactly these three. Each has a short answer ready in case a track asks how the project uses it.

### ✅ Pyth Network: Best use of Pyth market data

**Central.** The bell price is Pyth and nothing else. session-bell accepts a NYSE open or close only as a Pyth Lazer message: Solana's Ed25519 precompile checks the signature in the same transaction, and Pyth's own verifier confirms the signer by CPI. Every cross prices from that print, and every receipt re-verifies it in the browser.

**Sound.** The program parses every byte itself and applies a written rule: regular session only, confidence ≤25 bp, a window around the bell, strictly better replacement, and no feed dated more than 2 minutes past the chain's clock. Final prints are immutable accounts any Solana program can read, so a verified NYSE open and close becomes a public good. Tested in LiteSVM against Pyth's real mainnet verifier binary: 19 cases.

**After the hackathon.** On devnet, until we hold a Pyth Pro key, a rebuild of Pyth's verifier trusts a test signer, and every print is flagged SIMULATED on chain. Pointing the config at Pyth's program is the one-instruction switch. SESSION cannot run without Pyth, so three months of Pyth Pro is exactly what takes it to mainnet.

### ✅ PreStocks: Best Use of PreStocks

PreStocks tokens are a hard case for any order type: Token-2022 with a 1% transfer fee, a scaled-UI multiplier, and no exchange session at all. SESSION's first program was built for that shape. [/markets/OPENAI](https://session-roan.vercel.app/markets/OPENAI) runs it on an OPENAI token with every extension the real mint carries (devnet has no PreStocks tokens), and it has no NYSE clock, because OPENAI has no 09:30.

Its session boundary is PreStocks' own data. Our detector reads the live mark and executable price from prestocks.com/api/prestocks and posts both on chain, and the vault settles against them. On 25 Sep it read OPENAI at 27.8% over its mark.

We measured PreStocks' liquidity problem with live Jupiter quotes: a $50k buy moves OPENAI 7.2%, SPACEX 15.5% and NEURALINK 22.0%. Netting orders against each other at one reference price, as the cross does, is the answer to that impact. Valuation orders are the next build: "buy OPENAI below a $1.1T implied valuation", settled only if what arrives, net of the fee and the multiplier, meets the limit.

PreStocks tokens only: `npm test` fails if any other pre-IPO token enters the repository.

### ✅ Clawpump: Stocknized Agent on Clawpump

**$BELL is live on Solana mainnet**, launched through Clawpump by our registered agent, Bell (mint `7z9y4P3yatZki2AHHtzjPxEhjVTP1d362BQH1kDPdQTe`). Its bonding curve is quoted in **real NVDAx** instead of SOL, so the launch is stock-paired, and holding the agent's token is a position in the stock the agent serves. 75% of creator fees go to the agent.

The agent does real work on a real-world asset. Its role in SESSION is keeper and backstop market maker: it prices, clears and settles every cross, and offers to fill any bell's imbalance at 15 bp, earning the clearing fee in NVDAx and USDC. On devnet both roles run from our keeper service, and they carried the 25 Sep open end to end.

What it cannot do matters as much. Every crank is permissionless and the program caps the fee at 1%, so a late or hostile agent causes delay, never loss. Other agents trade the same bells through our 5 MCP tools.

The honest gap: the Meteora pool for $BELL/NVDAx isn't seeded yet. Today the NVDAx-quoted curve is the stock pair.

### Not selected

- **Meteora: Best Use of Meteora DBC.** DBC mints its own base token and prices it from demand. SESSION's instruments are priced by the bell, so an honest DBC use would be a side product, and the track rewards working mainnet code over slides.
- **The other pre-IPO token track.** Never select it. PreStocks makes any submission that integrates a non-PreStocks pre-IPO token ineligible, so entering it would forfeit the PreStocks track.

## Evidence index

| Claim | Where to check it |
|---|---|
| NVDA's opening print, $225.82, posted and verified on chain | [the print's transaction](https://explorer.solana.com/tx/4MyY1CX6q3GFESBhysCTdqSqP1nH1sN2g6d1boKDdRbqWBWJPaGdfgT5jQ8PPdBS58rG9cmKVUdnw7byvDgd1EA6?cluster=devnet) (instruction 1 is the Ed25519 precompile, behind a compute budget) |
| The cross priced, cleared and settled; the Jupiter comparison | [the receipt](https://session-roan.vercel.app/b/GdN6aYz68FBYxmwjVVUbJ9PEXrsku5nsDj7S18uX7PAb), which links every transaction |
| All five prints, finalised | [session-roan.vercel.app/oracle](https://session-roan.vercel.app/oracle) |
| Both issuer drills passed, escrows at zero | [`web/public/cross-drills.json`](https://github.com/iamdflame/session-protocol/blob/main/web/public/cross-drills.json); [`docs/CROSS.md`](https://github.com/iamdflame/session-protocol/blob/main/docs/CROSS.md#issuer-power-drills-on-devnet) |
| The oracle's rule and verification path | [`docs/BELL.md`](https://github.com/iamdflame/session-protocol/blob/main/docs/BELL.md), [`docs/METHOD.md`](https://github.com/iamdflame/session-protocol/blob/main/docs/METHOD.md) |
| The cross, its arithmetic and invariants | [`docs/CROSS.md`](https://github.com/iamdflame/session-protocol/blob/main/docs/CROSS.md), `crates/session-core/src/cross.rs` |
| 19 oracle and 9 exchange cases in LiteSVM, on the real NVDAx bytes and Pyth's verifier binary | `tests/integration/tests/bell.rs`, `cross.rs`, `fetch.sh` |
| 300 fuzzed crosses, matched to the atom | `tests/integration/tests/cross_fuzz.rs` |
| $BELL launched through Clawpump, quoted in real NVDAx | [the mint](https://solscan.io/token/7z9y4P3yatZki2AHHtzjPxEhjVTP1d362BQH1kDPdQTe), [the launch transaction](https://solscan.io/tx/4qCr3szZzQC25v2qp1rmuwFYDr9Ew2JViQF3XdLCxcBMkiQ4BE2DwAAwfcS2xLXNLJMNhe1FNLeQXH3cQu6twQp), [`web/public/bell.json`](https://github.com/iamdflame/session-protocol/blob/main/web/public/bell.json) |
| The PreStocks detector reads prestocks.com and posts on chain | `keeper/src/detector.ts`, [/markets/OPENAI](https://session-roan.vercel.app/markets/OPENAI) |
| Market figures | 63% outside hours: Solana Foundation newsletter and Crypto Briefing, through Aug 2026. Weekend deviation: bozBasket, 18–20 Sep 2026. Closing auctions at 8–15% of US volume: NYSE and BMLL. PreStocks impact: our Jupiter quotes, 24 Sep 2026. |

| Program (devnet) | Address |
|---|---|
| session-bell, the oracle | `BeLLKXJwhSH6YXYQLc8xLd11GxJUvoaT1h9zCadymJv4` |
| session-cross, the exchange | `Crosf1CpgcEs6G6SiX2B7KMR4hxVcE2FGU2r53a3RK9K` |
| Pyth's Lazer verifier, rebuilt for the devnet test signer | `CVuKQFLc1PAuJ8y7kPckw8Hi8W6WhdeWrhM9UBVdm2qs` |
| The NVDA market | `AYmob34FzFRo9kVBZA18jfcRSJJQfgpDKr7Kzc5FZJmb` |
| $BELL (mainnet) | `7z9y4P3yatZki2AHHtzjPxEhjVTP1d362BQH1kDPdQTe` |

## Before you press submit

1. **Keep this machine on and online through judging.** The bell poster and the cross keeper run here as systemd user services. If the machine sleeps, bells go unposted and crosses wait for a crank. No funds are at risk, since every step is permissionless and a cross with no print refunds, but a judge's order would sit unfilled.
2. **Open all three links in a private window.** The video must be Unlisted or Public, not Private.
3. **The receipt link lives for three weeks.** The keeper keeps a paid-out cross that long before closing it.
4. **Deadline:** 16:00 ET, which is 20:00 UTC, on 25 Sep 2026.
