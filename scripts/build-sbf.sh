#!/usr/bin/env bash
# Build every program for the chain, and refuse to leave an artifact behind if
# any function in any of them overran the SBF stack frame.
#
# cargo build-sbf prints "Stack offset ... exceeded max offset" as an Error
# line, exits 0, and writes the .so anyway. On chain that is an access
# violation in whichever instruction overran. Boxing one account fixed it
# once; adding Token-2022 accounts broke three more structs. A warning nobody
# can miss is worth more than a line in a runbook.
#
# The workspace now builds more than one program, and the overrun line names
# the function, not the artifact, so every .so this build wrote is removed:
# a half-good set of binaries is still a set somebody will deploy.
set -uo pipefail
cd "$(dirname "$0")/.."

log=$(mktemp)
stamp=$(mktemp)
cargo build-sbf "$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}

if grep -q "Stack offset" "$log"; then
  echo
  echo "REFUSING THE ARTIFACTS — $(grep -c 'Stack offset' "$log") function(s) overran the 4KiB SBF stack:"
  grep -oE "[a-z_]+\.\.[A-Za-z_]+" "$log" | sort -u | sed 's/^/  /'
  echo
  echo "Box the deserialised accounts in those structs: Box<Account<..>> / Box<InterfaceAccount<..>>."
  find target/deploy -maxdepth 1 -name '*.so' -newer "$stamp" -print -delete 2>/dev/null | sed 's/^/  removed /'
  # Anything older than this run was not written by it, but a failed build
  # should not leave a stale artifact looking current either.
  rm -f target/deploy/*.so
  rm -f "$log" "$stamp"
  exit 1
fi

rm -f "$log" "$stamp"
exit "$status"
