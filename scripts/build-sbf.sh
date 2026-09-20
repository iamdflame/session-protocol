#!/usr/bin/env bash
# Build the program for the chain, and refuse to leave an artifact behind if
# any function overran the SBF stack frame.
#
# cargo build-sbf prints "Stack offset ... exceeded max offset" as an Error
# line, exits 0, and writes the .so anyway. On chain that is an access
# violation in whichever instruction overran. Boxing one account fixed it
# once; adding Token-2022 accounts broke three more structs. A warning nobody
# can miss is worth more than a line in a runbook.
set -uo pipefail
cd "$(dirname "$0")/.."

log=$(mktemp)
cargo build-sbf "$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}

if grep -q "Stack offset" "$log"; then
  echo
  echo "REFUSING THE ARTIFACT — $(grep -c 'Stack offset' "$log") function(s) overran the 4KiB SBF stack:"
  grep -o "session\.\.[A-Za-z]*" "$log" | sort -u | sed 's/^/  /'
  echo
  echo "Box the deserialised accounts in those structs: Box<InterfaceAccount<..>>."
  rm -f target/deploy/session.so
  rm -f "$log"
  exit 1
fi

rm -f "$log"
exit "$status"
