#!/usr/bin/env bash
# Install and start one of this repository's systemd user services:
#
#   deploy/install-service.sh night-cost    the cost-of-the-night collector
#   deploy/install-service.sh bell-poster   the devnet bell poster
#
# deploy/<name>.service is a template: @NODE@ and @REPO@ are filled in here,
# because node comes from nvm, which a systemd unit cannot see. The unit runs
# whether or not anyone is logged in only if lingering is on for this user
# (`loginctl enable-linger $USER`); the script says which it is rather than
# assuming.
set -euo pipefail
cd "$(dirname "$0")/.."

name=${1:?usage: deploy/install-service.sh <night-cost|bell-poster>}
[ -f "deploy/$name.service" ] || { echo "no deploy/$name.service"; exit 1; }
repo=$(pwd)
node=$(command -v node) || { echo "node is not on PATH"; exit 1; }
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"

sed -e "s|@NODE@|$node|" -e "s|@REPO@|$repo|" "deploy/$name.service" > "$unit_dir/$name.service"
systemctl --user daemon-reload
systemctl --user enable --now "$name.service"
# a reinstall must pick up a changed unit or script, not keep the old process
systemctl --user restart "$name.service"

echo "installed: $unit_dir/$name.service"
echo "  node: $node"
echo "  repo: $repo"
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = "yes" ]; then
  echo "  linger: on — it keeps running with nobody logged in"
else
  echo "  linger: OFF — it stops at logout; run: loginctl enable-linger $USER"
fi
systemctl --user --no-pager status "$name.service" | head -5
