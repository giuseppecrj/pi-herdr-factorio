#!/usr/bin/env bash
# Remote, read-only. Run: scripts/vm.sh scripts/doctor.sh
# Prints versions and one repository-scoped gh read. Never prints credentials.
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
