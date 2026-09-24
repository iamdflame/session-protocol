#!/usr/bin/env bash
# Install and start the cost-of-the-night collector as a systemd user service.
#
# The unit runs whether or not anyone is logged in only if lingering is on for
# this user (`loginctl enable-linger $USER`); the script says which it is
# rather than assuming.
set -euo pipefail
cd "$(dirname "$0")/.."

repo=$(pwd)
node=$(command -v node) || { echo "node is not on PATH"; exit 1; }
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"

sed -e "s|@NODE@|$node|" -e "s|@REPO@|$repo|" deploy/night-cost.service > "$unit_dir/night-cost.service"
systemctl --user daemon-reload
systemctl --user enable --now night-cost.service

echo "installed: $unit_dir/night-cost.service"
echo "  node: $node"
echo "  repo: $repo"
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = "yes" ]; then
  echo "  linger: on — it keeps running with nobody logged in"
else
  echo "  linger: OFF — it stops at logout; run: loginctl enable-linger $USER"
fi
systemctl --user --no-pager status night-cost.service | head -5
