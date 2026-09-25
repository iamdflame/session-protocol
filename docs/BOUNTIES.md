# Sponsor tracks: three entered, two left out

The platform allows three sponsor tracks per submission. These three are the
ones SESSION cannot work without, or already runs on. The two left out are
explained below: one would be a side product, and the other would disqualify
an entry.

---

## Entered

### Pyth: the bell price is Pyth

**Central.** A bell order fills at the bell's print, and a print can only
enter as a Pyth Lazer (Pyth Pro) message. `programs/session-bell` checks it
three ways:
- Solana's Ed25519 precompile verifies the signature in the same transaction.
- Pyth's own verifier confirms the signer by CPI (`verify_message`: trusted, not expired).
- The program then parses every byte itself.

Every cross prices from that print, and every receipt re-verifies its
signature in the browser.

**Sound.** Rule v1 (`docs/METHOD.md`) decides which price is the open or the
close:
- the regular session only;
- confidence within 25 bp;
- a window around the bell;
- strict replacement: a later close, or an earlier open;
- no feed dated more than 120 s past the chain's clock.

Final prints are immutable accounts that any program can read by CPI: a
verified NYSE open and close on Solana, as a public good. The oracle runs in
LiteSVM against **Pyth's mainnet verifier binary**, dumped from the chain by
`tests/integration/fetch.sh`, and passes 19 cases.

**After the hackathon.** On devnet, until SESSION holds a Pyth Pro key:
- a rebuild of Pyth's verifier (`tools/lazer-devnet`) trusts a test signer;
- the program flags every print `simulated`, permanently.

Pointing `set_verifier` at Pyth's program is the whole switch
(`docs/OPERATIONS.md`, "Switching to Pyth Pro"). The product cannot run
without Pyth, so the prize, three months of Pyth Pro, is exactly what takes it
to mainnet.

### PreStocks: an event session on prestocks.com's own data

PreStocks tokens are a hard case for any order type. They are Token-2022,
with:
- a 1% transfer fee;
- a scaled-UI multiplier;
- a permanent delegate;
- a pause switch;
- no exchange session at all.

SESSION's first program was built for that shape.
[`/markets/OPENAI`](https://session-roan.vercel.app/markets/OPENAI) runs it on
an OPENAI token carrying every extension the real mint does, since devnet has
no PreStocks tokens. The page has no NYSE clock, because OPENAI has no 09:30.

Its session boundary is PreStocks' own data:
- **The detector** (`keeper/src/detector.ts`, run by the site's
  `/api/detector`) reads the live mark and executable price from
  `prestocks.com/api/prestocks`, and posts both on chain. The vault settles
  against them.
- **On 25 Sep** it read OPENAI at 27.8% over its mark.
- **It is the one place the product rests on somebody's word.** The page says
  so in its footer.

**The problem, measured.** With live Jupiter quotes on 24 Sep, a $50k buy
moved OPENAI 7.2%, SPACEX 15.5% and NEURALINK 22.0%. Netting orders against
each other at one reference price, as the cross does, is the answer to that
impact.

**Next: valuation orders.** For example, "buy OPENAI below a $1.1T implied
valuation". One settles only if what arrives, net of the fee and the
multiplier, meets the limit.

**The eligibility rule is enforced by `npm test`, not by intention.**
PreStocks disqualifies any submission that integrates a competing pre-IPO
token, so `scripts/eligibility.mjs` scans every tracked file and fails the
test run if one appears.

The rule runs locally, rather than only in CI, because this account's GitHub
Actions are locked for billing, and CI has never run a job. The first version
of the rule was also wrong. It used a bare substring grep, which matched our
own `devnet-openai.json` inside the word `devnet-openai`. It matches whole
tokens now. This file is the one place exempted, because naming a thing in
order to say it was refused is not carrying it.

### Clawpump: `$BELL`, the keeper's token, quoted in the stock

**`$BELL` is live on Solana mainnet:**
- mint [`7z9y4P3yatZki2AHHtzjPxEhjVTP1d362BQH1kDPdQTe`](https://solscan.io/token/7z9y4P3yatZki2AHHtzjPxEhjVTP1d362BQH1kDPdQTe);
- launched through Clawpump by our registered agent, Bell (`agent/launch.ts`, `web/public/bell.json`);
- its curve is denominated in **real NVDAx** (`Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh`), not SOL, so holding the agent's token is a position in the stock the agent serves;
- 75% of creator fees go to the agent.

**The agent does real work on a real-world asset.** Its role in SESSION is
keeper and backstop market maker:
- it prices, clears, settles and closes every cross;
- it offers to fill any bell's imbalance at 15 bp, and earns the clearing fee in NVDAx and USDC.

On devnet both roles run from the keeper service (`deploy/railway`), and they
carried the 25 Sep open end to end. Other agents trade the same bells through
five MCP tools (`agent/mcp.ts`).

**What it cannot do** matters as much. Every crank is permissionless, and the
program caps the fee ladder at 1%. A late, absent or hostile keeper therefore
causes delay, never loss. `/bell` lists these limits.

**The gap.** Clawpump's letter asks for a stock-paired pool "using clawpump
and Meteora". The Meteora pool for `$BELL/NVDAx` is not seeded yet, so today
the NVDAx-quoted curve is the stock pair. Seeding it needs inventory the
mainnet wallet does not hold.

---

## Left out

### Meteora DBC

DBC mints its own base token and prices it from demand. SESSION's instruments
are priced by the bell, so an honest DBC use would be a side product, and the
track rewards working mainnet code over slides.

The first program does have a Meteora pool. `NVDA.DAY/quote` is on DAMM v2 on
devnet, with a verified swap: 10 DAY in, 9.92 quote out. That is DAMM v2 on
devnet, not DBC on mainnet, and claiming it for this track would be the kind
of stretch this file exists to avoid.

### Tessera

Entering it would forfeit PreStocks. PreStocks disqualifies any submission
that integrates a competing pre-IPO token, and the platform allows one
submission per team. `npm test` refuses to run if one is referenced anywhere
else in the tracked tree.
