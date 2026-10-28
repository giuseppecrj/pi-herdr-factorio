#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lane-id.sh"
script="$1"
shift
if [ "$#" -ge 2 ]; then
  require_lane_ids "$1" "$2" || exit 2
fi
quoted=""
for a in "$@"; do quoted="$quoted $(printf '%q' "$a")"; done
export SSH_AUTH_SOCK="${SSH_AUTH_SOCK_OVERRIDE:-$HOME/.ssh/headless-agent.sock}"
cat "$here/lane-id.sh" "$script" | ssh exedev@pi-factorio.exe.xyz "bash -s --$quoted"
