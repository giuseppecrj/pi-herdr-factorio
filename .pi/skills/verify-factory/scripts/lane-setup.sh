#!/usr/bin/env bash
# Local. Run from the checkout under test: scripts/lane-setup.sh <pr-id> <worker-n>
# Ships `git archive HEAD` to the lane workspace on the VM and installs
# the committed dependencies there. Never touches the controller's checkout.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
pr="$1"
n="$2"
lane="/home/exedev/factory-verification/$pr-w$n"
sha="$(git rev-parse HEAD)"
export SSH_AUTH_SOCK="${SSH_AUTH_SOCK_OVERRIDE:-$HOME/.ssh/headless-agent.sock}"
git archive HEAD | ssh exedev@pi-factorio.exe.xyz "mkdir -p $lane && cat > $lane/src.tar"
"$here/vm.sh" "$here/remote-setup.sh" "$pr" "$n" "$sha"
