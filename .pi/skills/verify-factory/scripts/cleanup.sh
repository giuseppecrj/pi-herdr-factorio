#!/usr/bin/env bash
set -euo pipefail
pr="$1"; n="$2"
case "$pr$n" in *[!A-Za-z0-9_-]*|"") echo "bad lane id" >&2; exit 2;; esac
lane="/home/exedev/factory-verification/$pr-w$n"
rm -rf -- "$lane"
rmdir /home/exedev/factory-verification 2>/dev/null || true
echo "removed=$lane"
echo "evidence_kept=/tmp/swarm-$pr/worker-$n"
ls -l "/tmp/swarm-$pr/worker-$n"
