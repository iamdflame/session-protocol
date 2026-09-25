#!/bin/sh
# Railway entrypoint. Writes the devnet keys from the service's variables to
# the paths the keepers read, then runs the one keeper SESSION_ROLE names.
# The keys are never in the image or the upload.
set -eu
umask 077
mkdir -p keeper/.devnet data
put() {
  v=$(printenv "$1" || true)
  [ -n "$v" ] && printf '%s' "$v" > "keeper/.devnet/$2"
  return 0
}
put BELL_SIGNER_KEY bell-signer.json
put BELL_POSTER_KEY bell-poster.json
put BELL_MAKER_KEY bell-maker.json
case "${SESSION_ROLE:-}" in
  bell-poster)  exec node dist/bell-poster.mjs --simulate ;;
  cross-keeper) exec node dist/cross-keeper.mjs ;;
  *) echo "SESSION_ROLE must be bell-poster or cross-keeper" >&2; exit 1 ;;
esac
