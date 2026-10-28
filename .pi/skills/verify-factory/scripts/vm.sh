#!/usr/bin/env bash
set -euo pipefail
script="$1"
shift
export SSH_AUTH_SOCK="${SSH_AUTH_SOCK_OVERRIDE:-$HOME/.ssh/headless-agent.sock}"
exec ssh exedev@pi-factorio.exe.xyz bash -s -- "$@" < "$script"
