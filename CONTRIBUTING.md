# Working on SESSION

```bash
npm install          # workspace root — installs the site too
npm test             # 103 Rust tests + 4 TypeScript suites
cd web && npm run verify
```

## Before changing anything that decides who gets paid

The accounting is written twice, in Rust and TypeScript, and pinned together by
vectors. If you touch `settle.rs`, `calendar.rs`, `funding.rs` or their SDK
mirrors, regenerate and commit the vectors:

```bash
npm run vectors
```

A calendar change also has to pass `web/scripts/gen-ground.ts`, which rebuilds
the site's pre-paint session script and refuses to emit if it disagrees with the
module across 313,117 timestamps.

## Two traps that have already cost time

- **`cargo update` breaks the SBF build.** Seven host-side crates are pinned
  below Rust edition 2024 because platform-tools ships Cargo 1.84. Update
  individually with `cargo update -p <crate>@<ver> --precise <ver>`, or move to
  a platform-tools release whose Cargo is ≥ 1.85 and drop the pins.
  `docs/OPERATIONS.md` has the list.
- **A build that prints `Stack offset … exceeded` is not deployable.** The
  toolchain writes the artifact anyway; on chain it is an access violation.

## The bar for a number on screen

Every figure on the site traces to a file under `data/`, a live fetch, or the
SDK. The headline figures in the copy are computed at build time from the study
rather than typed into prose, so a corrected measurement cannot leave a stale
sentence behind. If you add a claim, add the derivation with it.

## Checks worth running before a PR

| | |
|---|---|
| `npm test` | the program and the cross-language vectors |
| `cd web && npm run verify` | types, the ground script, the product flow in a browser, settlement across boundaries, accessibility on both grounds |
| `npm run devnet:check` | every instruction's encoding against the deployed program (needs `keeper/.devnet/`) |

`docs/AUDIT.md` is the record of what was wrong before it was right. If you find
something, it belongs there too.
