#!/usr/bin/env bash
# Fetch the Pyth Lazer (Pyth Pro) verifier exactly as deployed on mainnet.
#
# The harness runs session-bell against Pyth's own binary rather than a build
# of its source, so what is tested is what a mainnet post would call. The
# binary is not committed: it is Pyth's, it is 300KB+, and a stale copy is
# worse than none. Re-run this to test against whatever Pyth has deployed now.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p fixtures
solana program dump -u m pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt fixtures/pyth_lazer.so
sha256sum fixtures/pyth_lazer.so
