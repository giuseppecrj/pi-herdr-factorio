#!/bin/bash
# ship.sh <runner.sh> : copy every prototype script to /home/exedev/f05-proto2 on pi-factorio, run the runner.
# The runner gets stdin from /dev/null so it cannot consume the ssh script.
set -eu
cd "$(dirname "$0")"
runner=$1
FILES=(common.sh setup.sh gateway.py gwsummary.py rpcdrive.py fakeup.py sbx-entry.sh
       exp5_inside.sh exp5_parent.py exp9_inside.sh exp10_inside.sh run_exp*.sh vm_cleanup.sh)
{
  echo 'set -eu; mkdir -p /home/exedev/f05-proto2; cd /home/exedev/f05-proto2'
  echo 'base64 -d <<"B64EOF" | tar xz'
  tar cz "${FILES[@]}" 2>/dev/null | base64
  echo 'B64EOF'
  echo 'mkdir -p scripts; cp sbx-entry.sh exp5_inside.sh exp5_parent.py exp9_inside.sh exp10_inside.sh scripts/; chmod 755 scripts/*.sh'
  echo "bash ./$runner ${RUNNER_ARGS:-} </dev/null 2>&1"
} | SSH_AUTH_SOCK=$HOME/.ssh/headless-agent.sock ssh exedev@pi-factorio.exe.xyz bash -s
