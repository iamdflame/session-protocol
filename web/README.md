# SESSION — the site

The product website and app for the SESSION protocol. Vite + React, no chart
library, no UI kit. It imports the protocol's own SDK (`../sdk/src`) rather than
vendoring a copy, so the calendar that drives the clock and the `settle()` that
drives the local vault are the same code the on-chain program is pinned to.

## Run

    npm install
    npm run dev          # http://localhost:3100
    npm run build        # regenerates data, builds to dist/
    npm run preview      # serves dist/ on :3200

`build` pins `NODE_ENV=production` deliberately — Vite honours an ambient
`NODE_ENV=development` and will ship React's development runtime, which is 1.8×
the size and an order of magnitude slower to render.

## Verify

    npm run verify       # everything below, in order

| script        | what it checks                                                        |
|---------------|-----------------------------------------------------------------------|
| `check`       | TypeScript, strict, including the SDK it imports                      |
| `ground`      | regenerates the pre-paint ground script and refuses if it disagrees with the calendar across 313,117 timestamps |
| `flow`        | drives a real browser through mint → refused class → redeem → persistence → reset (35 assertions) |
| `settle`      | drives the local vault across real boundaries with chosen marks: exposure flips, funding is a transfer, backing covers claims, bad debt halts (26 assertions) |
| `a11y`        | names, headings, keyboard reach and computed contrast on every page, both grounds |
| `shot`        | full-page screenshots at 1440 / 1024 / 768 / 390, either ground        |
| `perf`        | at-rest main-thread cost under 4× CPU throttle                         |

`flow`, `settle`, `chain`, `a11y` and `shot` need the dev server running;
`perf` needs `preview`. `functions` bundles the two serverless functions and
runs as part of `build`.

## On chain

`public/devnet.json` names the live devnet vault. A symbol with a vault there
renders the on-chain page (`ChainVault`): state read with the SDK's
`decodeVault`, transactions built with `sdk/src/ix.ts` and signed in the
connected wallet, health from the SDK's `evaluate()`. Every other symbol runs
the local simulation of the same code and says so.

Wallets are picked up through the Wallet Standard — no adapter list to
maintain. The modal, the button and the providers are in
`src/components/wallet/`.

`api-src/` holds two serverless functions, bundled by `scripts/functions.mjs`
into `api/` before Vercel sees them (Vercel does not trace imports that leave
the project root, and both share `../../sdk` and `../../keeper`):

| endpoint | does |
|---|---|
| `GET /api/crank` | settle a due boundary, fill any handoff, report state |
| `POST /api/faucet` | 10,000 test quote + fee SOL to a wallet |

Both need `OPERATOR_KEYPAIR` in the environment.

| script | what it checks |
|---|---|
| `chain` | drives the on-chain page in a real browser with an injected Wallet Standard wallet: connect, mint (verified on devnet), refused class, redeem, disconnect |
| `chain:prod` | the same against the production URL with a brand-new wallet, funded through the site's own faucet |

## Data

`npm run data` derives everything the site ships from `../data/_hourly.json`
through the same calendar the program uses, and applies the same single-bar
spike rejection the study applies (`../research/clean.ts`). The headline
figures the copy quotes are computed here too, so a sentence cannot drift from
the study it describes.
