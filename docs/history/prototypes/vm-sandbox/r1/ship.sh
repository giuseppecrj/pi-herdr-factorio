#!/bin/bash
# ship.sh <runner.sh> [files...] : copy files to /home/exedev/f05-proto on pi-factorio and run the runner there.
# The runner runs with stdin from /dev/null, so it cannot consume the ssh script.
set -eu
cd "$(dirname "$0")"
runner=$1; shift
{
  echo 'set -eu; mkdir -p /home/exedev/f05-proto; cd /home/exedev/f05-proto'
  echo 'base64 -d <<"B64EOF" | tar xz'
  tar cz "$runner" "$@" | base64
  echo 'B64EOF'
  echo "bash ./$runner ${RUNNER_ARGS:-} </dev/null 2>&1"
} | SSH_AUTH_SOCK=$HOME/.ssh/headless-agent.sock ssh exedev@pi-factorio.exe.xyz bash -s
