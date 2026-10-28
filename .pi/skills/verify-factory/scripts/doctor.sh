#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
echo "host=$(hostname)"
echo "node=$(node --version)"
echo "pi=$(pi --version)"
echo "herdr=$(herdr --version)"
echo "gh=$(gh --version | head -1)"
echo "image=$(. /etc/os-release && echo "$PRETTY_NAME")"
GH_HOST=github.int.exe.xyz gh repo view giuseppecrj/pi-herdr-factorio \
  --json nameWithOwner,defaultBranchRef,visibility \
  --jq '"repo=" + .nameWithOwner + " default=" + .defaultBranchRef.name + " " + .visibility'
echo "doctor=ok"
