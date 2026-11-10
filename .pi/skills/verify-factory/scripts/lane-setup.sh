#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lane-id.sh"
. "$here/target.sh"
pr="$1"
n="$2"
require_lane_ids "$pr" "$n" || exit 2
sha="$(git rev-parse HEAD)"
export SSH_AUTH_SOCK="${SSH_AUTH_SOCK_OVERRIDE:-$HOME/.ssh/headless-agent.sock}"
stage='lane="/home/exedev/factory-verification/$1-w$2" && mkdir -p "$lane" && cat > "$lane/src.tar"'
git archive HEAD | ssh "$target_ssh" "bash -c $(printf '%q' "$stage") _ $(printf '%q' "$pr") $(printf '%q' "$n")"
"$here/vm.sh" "$here/remote-setup.sh" "$pr" "$n" "$sha"
