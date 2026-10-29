#!/usr/bin/env bash
set -uo pipefail
pr="$1"; n="$2"; minutes="$3"; glob="$4"
require_lane_ids "$pr" "$n" || exit 2
case "$minutes" in ""|*[!0-9]*) echo "minutes must be a whole number" >&2; exit 2;; esac
case "$glob" in ""|*[!A-Za-z0-9._*?-]*) printf 'refusing glob: %q\n' "$glob" >&2; exit 2;; esac
root=/home/exedev/factory-verification
out="/tmp/swarm-$pr/worker-$n"
mkdir -p "$out"
file="$out/vm-snapshot-$(date -u +%Y%m%dT%H%M%SZ).txt"
{
  echo "taken=$(date -u +%FT%TZ) minutes=$minutes glob=$glob"
  echo "## lanes"
  ls -1 "$root" 2>/dev/null | sort
  echo "## processes (node, gh, pi owned by exedev)"
  ps -u exedev -o pid=,ppid=,comm= | awk '$3 == "node" || $3 == "gh" || $3 == "pi"' | sort -n
  echo "## files changed under ~ in the last $minutes minutes"
  find "$HOME" \( -path "$root" -o -path "$HOME/.npm" -o -path "$HOME/.cache" \) -prune \
    -o -type f -mmin "-$minutes" -print 2>/dev/null | sort
  echo "## /tmp entries matching $glob"
  find /tmp -maxdepth 1 -name "$glob" -print 2>/dev/null | sort
} > "$file"
cat "$file"
echo "snapshot=$file"
