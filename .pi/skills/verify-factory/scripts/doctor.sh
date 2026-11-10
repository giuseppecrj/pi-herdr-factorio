#!/usr/bin/env bash
set -euo pipefail
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  # Run directly from a file: send this script to the selected VM instead.
  exec "$(dirname "${BASH_SOURCE[0]}")/vm.sh" "${BASH_SOURCE[0]}"
fi
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
echo "target=${FACTORY_VM:?send this script with vm.sh}"
echo "host=$(hostname)"
echo "node=$(node --version)"
node -e 'const [a,b,c]=process.versions.node.split(".").map(Number);process.exit(a>26||(a===26&&(b>12||(b===12&&c>=1)))?0:1)' \
  || { echo "doctor: node below 26.12.1" >&2; exit 1; }
echo "pi=$(pi --version)"
echo "herdr=$(herdr --version)"
echo "gh=$(gh --version | head -1)"
echo "image=$(. /etc/os-release && echo "$PRETTY_NAME")"
GH_HOST="${GH_HOST:?send this script with vm.sh}" gh repo view nublai/pi-herdr-factorio \
  --json nameWithOwner,defaultBranchRef,visibility \
  --jq '"repo=" + .nameWithOwner + " default=" + .defaultBranchRef.name + " " + .visibility'
echo "doctor=ok"
