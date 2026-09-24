# Pyth's Lazer verifier, under a devnet id of its own

SESSION's bell program accepts a price only after a CPI into a Pyth Pro verifier has checked the price's Ed25519 signature. On mainnet, and on Pyth's own devnet instance, that verifier is Pyth's Lazer program. It trusts Pyth's signers and nobody else's. Until SESSION holds a Pyth Pro subscription, the devnet bell needs a verifier that trusts a test key instead.

This directory is that verifier. It is Pyth's source, `pyth-lazer-solana-contract` 0.8.0, copied from the published crate with three changes. Each change is marked `SESSION:` in the source:

1. **Its own program id**, `CVuKQFLc1PAuJ8y7kPckw8Hi8W6WhdeWrhM9UBVdm2qs`, and therefore its own `["storage"]` account and its own trusted signers.
2. **No `pyth-lazer-protocol` dependency.** `verify_message` reads one constant from it, the Solana format magic. That constant is now written out in `signature.rs`. The crate's other dependencies (protobuf, utoipa, chrono…) do not build under the Solana platform tools this repository pins.
3. **No `verify_ecdsa_message`.** It was the one instruction that needed more of that crate. A bell post uses Ed25519 only.

`verify_message`, and everything it calls, is otherwise Pyth's code byte for byte.

## Why this is enough

`tests/integration` runs the bell program's full end-to-end suite against Pyth's mainnet binary. The same suite runs against this build:

```bash
cd tests/integration
cargo test --test bell                                   # Pyth's binary, from fetch.sh
BELL_VERIFIER_ID=CVuKQFLc1PAuJ8y7kPckw8Hi8W6WhdeWrhM9UBVdm2qs \
BELL_VERIFIER_SO=../../tools/lazer-devnet/target/deploy/pyth_lazer_devnet.so \
cargo test --test bell                                   # this build
```

All 18 cases pass against both. The only difference the bell can see is the one it is built to see: any verifier that is not Pyth's own program id makes every print `simulated`, permanently.

## Build and deploy

```bash
cp keeper/.devnet/lazer_devnet-keypair.json tools/lazer-devnet/target/deploy/pyth_lazer_devnet-keypair.json
cargo build-sbf --manifest-path tools/lazer-devnet/Cargo.toml
solana program deploy tools/lazer-devnet/target/deploy/pyth_lazer_devnet.so \
  --program-id tools/lazer-devnet/target/deploy/pyth_lazer_devnet-keypair.json --url devnet
```

Then `initialize` it and `update` the test signer: `keeper/src/bell-devnet.ts` does both. The `Cargo.lock` here started as a copy of the repository's, so the SBF build resolves to the versions already known to build under platform-tools v1.48.

Licensed Apache-2.0 (`LICENSE-APACHE`), as Pyth publishes it.
