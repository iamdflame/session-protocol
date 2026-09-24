#!/usr/bin/env bash
# Build every program for the chain, and refuse to leave an artifact behind if
# any function in any of them overran the SBF stack frame, or if any artifact
# is too small to be a program at all.
#
# cargo build-sbf prints "Stack offset ... exceeded max offset" as an Error
# line, exits 0, and writes the .so anyway. On chain that is an access
# violation in whichever instruction overran. Boxing one account fixed it
# once; adding Token-2022 accounts broke three more structs. A warning nobody
# can miss is worth more than a line in a runbook.
#
# Each program is built in its own cargo invocation. session-cross depends on
# session-bell with its `cpi` feature, and one workspace build unifies
# features: session-bell was compiled without its entrypoint and came out a
# valid, 896-byte, empty program. Built alone, each program gets only its own
# features — and any .so under 20 KB is refused anyway, because an empty
# program deploys as happily as a real one.
#
# The overrun line names the function, not the artifact, so every .so is
# removed on a refusal: a half-good set of binaries is still a set somebody
# will deploy.
set -uo pipefail
cd "$(dirname "$0")/.."

log=$(mktemp)
status=0
for manifest in programs/*/Cargo.toml; do
  echo "── $(dirname "$manifest")"
  cargo build-sbf --manifest-path "$manifest" "$@" 2>&1 | tee -a "$log"
  s=${PIPESTATUS[0]}
  [ "$s" -ne 0 ] && status=$s
done

refuse() {
  echo
  echo "REFUSING THE ARTIFACTS — $1"
  rm -f target/deploy/*.so
  rm -f "$log"
  exit 1
}

if grep -q "Stack offset" "$log"; then
  echo
  echo "$(grep -c 'Stack offset' "$log") function(s) overran the 4KiB SBF stack:"
  grep -oE "[a-z_]+\.\.[A-Za-z_]+" "$log" | sort -u | sed 's/^/  /'
  echo "Box the deserialised accounts in those structs: Box<Account<..>> / Box<InterfaceAccount<..>>."
  refuse "a stack frame overran"
fi

for so in target/deploy/*.so; do
  size=$(stat -c %s "$so")
  if [ "$size" -lt 20000 ]; then
    refuse "$so is $size bytes: too small to be a program (built without its entrypoint?)"
  fi
  echo "  $(basename "$so"): $size bytes"
done

rm -f "$log"
exit "$status"
