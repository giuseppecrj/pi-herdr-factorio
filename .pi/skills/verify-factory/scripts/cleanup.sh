#!/usr/bin/env bash
set -euo pipefail
pr="$1"; n="$2"
require_lane_ids "$pr" "$n" || exit 2
lane="/home/exedev/factory-verification/$pr-w$n"
rm -rf -- "$lane"
rmdir /home/exedev/factory-verification 2>/dev/null || true
echo "removed=$lane"
echo "evidence_kept=/tmp/swarm-$pr/worker-$n"
ls -l "/tmp/swarm-$pr/worker-$n"
