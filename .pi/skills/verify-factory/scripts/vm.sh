#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lane-id.sh"
. "$here/target.sh"
script="$1"
shift
if [ "$#" -ge 2 ]; then
  require_lane_ids "$1" "$2" || exit 2
fi
quoted=""
for a in "$@"; do quoted="$quoted $(printf '%q' "$a")"; done
export SSH_AUTH_SOCK="${SSH_AUTH_SOCK_OVERRIDE:-$HOME/.ssh/headless-agent.sock}"
rc=0
{ printf 'export FACTORY_VM=%q GH_HOST=%q\n' "$FACTORY_VM" "$target_gh_host"; cat "$here/lane-id.sh" "$script"; } \
  | ssh "$target_ssh" "bash -s --$quoted" || rc=$?
[ "$rc" -eq 0 ] || printf 'target %s: exit %s\n' "$FACTORY_VM" "$rc" >&2
exit "$rc"
