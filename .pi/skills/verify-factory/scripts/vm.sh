#!/usr/bin/env bash
# Run a script on the pi-factorio VM: vm.sh <script> [args...]
# The script is sent on stdin with `bash -s`, so no quoting crosses ssh.
set -euo pipefail
script="$1"
shift
export SSH_AUTH_SOCK="${SSH_AUTH_SOCK_OVERRIDE:-$HOME/.ssh/headless-agent.sock}"
exec ssh exedev@pi-factorio.exe.xyz bash -s -- "$@" < "$script"
