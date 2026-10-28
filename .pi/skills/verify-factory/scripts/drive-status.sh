#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
pr="$1"; n="$2"
lane="/home/exedev/factory-verification/$pr-w$n"
out="/tmp/swarm-$pr/worker-$n"
mkdir -p "$out"
cp "$lane/ws/.pi/skills/verify-factory/scripts/status-driver.ts" "$lane/ws/.status-driver.ts" 2>/dev/null \
  || { echo "driver missing from lane workspace" >&2; exit 2; }
start="$(date -u +%FT%TZ)"
set +e
(cd "$lane/ws" && node --experimental-strip-types .status-driver.ts status) > "$out/status.txt" 2> "$out/status.err"
rc=$?
set -e
end="$(date -u +%FT%TZ)"
{
  echo "feature=factory-status"
  echo "command=node --experimental-strip-types .status-driver.ts status (in $lane/ws)"
  echo "head_sha=$(cat "$lane/head-sha")"
  echo "started=$start"
  echo "ended=$end"
  echo "exit=$rc"
  echo "expected=first line 'pi-herdr-factorio <version>' followed by the stage table"
  echo "actual_first_line=$(head -1 "$out/status.txt")"
  echo "stdout_lines=$(wc -l < "$out/status.txt")"
} > "$out/evidence.txt"
cat "$out/evidence.txt"
echo "--- status.txt"
cat "$out/status.txt"
[ "$rc" -eq 0 ] && head -1 "$out/status.txt" | grep -q '^pi-herdr-factorio '
