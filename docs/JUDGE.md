# Sixty seconds

The claim, the evidence, and the parts that are not real yet, in the order that
lets you check them rather than believe them.

---

## The claim

A tokenized stock trades 168 hours a week, but its price is made in 6.5, and
most of the trading happens in the hours it isn't: 63% of tokenized-equity
volume, when pools are thinnest. Wall Street's answer to a thin book is the
auction at the bell. Tokenized stocks have none.

**SESSION is that auction, on Solana.**
- An order placed at any hour fills at the NYSE open or close, at the bell's Pyth print, verified on chain.
- Everyone in the bell gets one price.
- Buyers and sellers net against each other with no fee, and makers fill only the imbalance.
- Every cross gets a receipt, with the swap it beat, or lost to, beside it.

## The evidence: one real bell

At the 25 September 2026 open, on devnet, with nobody at the keyboard:

- **The prints.** All five listings were posted and finalised. NVDA opened at $225.82, 16 s after 09:30 ET.
- **The cross.** The NVDA cross priced, cleared and settled 4 test orders and the backstop's offer. Buyers were crowded, and paid the 15 bp fee only on the part the maker filled.
- **Against Jupiter** at 09:30:03 ET, sellers got 37.16 bp more and buyers 33.99 bp less. **The receipt shows the loss as plainly as the gain.** A comparison that could only ever say "you saved" would be an advertisement.
- **Both issuer drills passed** at the same bell, and both escrows ended at zero:
  - a paused mint, where the quote legs were paid and the tokens waited for the resume;
  - a multiplier change, where the cross cancelled and everyone was refunded whole.

## Sixty seconds, in order

1. **[/bells](https://session-roan.vercel.app/bells)** *(10 s)*. No wallet needed. It shows the next open and close, the book, and the ticket with "Now, on Jupiter" beside "At the bell".
2. **[The receipt](https://session-roan.vercel.app/b/GdN6aYz68FBYxmwjVVUbJ9PEXrsku5nsDj7S18uX7PAb)** *(20 s)*. Look for:
   - the print's signature, verified again by your browser;
   - the signed feed matching the stored print, field by field;
   - the fills and the fee;
   - Jupiter's quote beside them, from a memo inside the pricing transaction, signed by the keeper the manifest names.
3. **Place one** *(20 s)*. Connect a devnet wallet, take the faucet on the page, and order for the next real bell. The keepers run on Railway, so it fills and settles without us.
4. **[/oracle](https://session-roan.vercel.app/oracle)** *(10 s)*. Every print, each linked to its transaction.

To check the chain rather than the page, open [NVDA's post](https://explorer.solana.com/tx/4MyY1CX6q3GFESBhysCTdqSqP1nH1sN2g6d1boKDdRbqWBWJPaGdfgT5jQ8PPdBS58rG9cmKVUdnw7byvDgd1EA6?cluster=devnet):
- instruction 0 sets the compute budget;
- instruction 1 is the Ed25519 precompile;
- instruction 2 is `post_print`, which calls the verifier `CVuKQF…`.

Then open [the pricing transaction](https://explorer.solana.com/tx/3M2EkG2pG4Pqimx7zUrq93BfSJaZsQsEEatipEJ9WygpanAxNWuXsZzi8RDVaBbKv6VkQ5UF9aK25zdfQcKVG3cx?cluster=devnet), whose memo is the Jupiter quote.

## What is real, and what is not

**Real**
- Both programs, on devnet, at real NYSE bell times, cranked by a keeper that runs unattended.
- The verification path. It is Pyth's own verifier code, called exactly as a mainnet post calls it. In tests it is Pyth's mainnet binary.
- The counterfactual: live mainnet Jupiter quotes for the real NVDAx.
- `$BELL` on mainnet, launched through Clawpump and quoted in real NVDAx.

**Not real yet**
- **The signer.** SESSION has no Pyth Pro key, so a test key signs devnet prints, and a rebuild of Pyth's verifier trusts it. The price source is Jupiter's stock data. The program flags every such print `simulated` for good, and every page says so first.
- **The tokens.** A fixture NVDAx carries the real mint's extensions and multiplier bits, alongside test USDC.
- **The orders.** They are the team's labelled test traders, and yours if you place one.
- **Mainnet, and an audit.** Neither has happened.

## Where it rests on somebody's word

- **On devnet, the price.** The test signer is ours. With a Pyth Pro key the signer is Pyth's, and `set_verifier` points the oracle at Pyth's own program. The `simulated` flag is set by the program from the verifier's id, so it cannot be cleared by a claim.
- **The counterfactual quote.** It is the keeper's word for what Jupiter quoted at that moment. The chain timestamps it and the named keeper signs it, but nobody can re-derive it afterwards, and the receipt says whose word it is.

Everything else is on chain, and the receipt re-checks it in your browser.

## What the first real bell caught

Two receipt bugs surfaced at the 25 Sep open. Neither could have shown up in a test that places the Ed25519 instruction first.

- **A verified print was reported as unverified.** The poster puts a compute-budget instruction first, so the Ed25519 check sits at index 1. The first receipt looked only at index 0. It now reads the index that `post_print` itself names in its data, and a test pins it.
- **A settled cross was described wrongly.** The receipt called a paid-out escrow "still held" when all it held was rounding dust. It now names the dust, which goes to the treasury when the cross closes.
