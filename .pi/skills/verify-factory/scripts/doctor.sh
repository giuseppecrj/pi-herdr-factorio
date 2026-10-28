#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
echo "host=$(hostname)"
echo "node=$(node --version)"
node -e 'const [a,b,c]=process.versions.node.split(".").map(Number);process.exit(a>26||(a===26&&(b>12||(b===12&&c>=1)))?0:1)' \
  || { echo "doctor: node below 26.12.1" >&2; exit 1; }
echo "pi=$(pi --version)"
echo "herdr=$(herdr --version)"
echo "gh=$(gh --version | head -1)"
echo "image=$(. /etc/os-release && echo "$PRETTY_NAME")"
GH_HOST=github.int.exe.xyz gh repo view giuseppecrj/pi-herdr-factorio \
  --json nameWithOwner,defaultBranchRef,visibility \
  --jq '"repo=" + .nameWithOwner + " default=" + .defaultBranchRef.name + " " + .visibility'
echo "doctor=ok"
