#!/usr/bin/env bash
# Deploy the devnet bell poster and cross keeper to Railway, so bells are
# posted and crosses settle whether or not any laptop is on.
#
#   deploy/railway/deploy.sh                  both services
#   deploy/railway/deploy.sh cross-keeper     one
#
# It uploads a staging folder holding only the two bundled keepers, the public
# manifests they read, and this folder's Dockerfile, start.sh and railway.json.
# Nothing else in the repository can reach Railway, keys included: those are
# service variables, set once (docs/OPERATIONS.md, "Keepers on Railway").
# Redeploy after any change to the keeper or to web/public/{bell,cross}-*.json.
set -euo pipefail
cd "$(dirname "$0")/../.."

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/dist" "$stage/web/public"

node_modules/.bin/esbuild keeper/src/bell-poster.ts keeper/src/cross-keeper.ts \
  --bundle --platform=node --format=esm --target=node22 --log-level=warning \
  --outdir="$stage/dist" --out-extension:.js=.mjs \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
cp web/public/bell-devnet.json web/public/cross-devnet.json web/public/cross-drills.json "$stage/web/public/"
cp deploy/railway/Dockerfile deploy/railway/start.sh deploy/railway/railway.json "$stage/"

# A 64-byte secret key is a JSON array of 64 numbers; none belongs in the upload.
if grep -rlE '\[ *([0-9]{1,3} *, *){63}[0-9]{1,3} *\]' "$stage"; then
  echo "refusing: a key-shaped array is in the upload" >&2; exit 1
fi

services=("$@")
[ ${#services[@]} -eq 0 ] && services=(bell-poster cross-keeper)
for svc in "${services[@]}"; do
  echo "deploying $svc"
  railway up "$stage" --path-as-root --service "$svc" --detach -m "$(git rev-parse --short HEAD)"
done
