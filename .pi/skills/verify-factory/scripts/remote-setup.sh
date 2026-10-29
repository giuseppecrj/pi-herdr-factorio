#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
pr="$1"; n="$2"; sha="$3"
require_lane_ids "$pr" "$n" || exit 2
case "$sha" in *[!0-9a-f]*|"") echo "bad sha" >&2; exit 2;; esac
lane="/home/exedev/factory-verification/$pr-w$n"
rm -rf "$lane/ws" "$lane/state"
mkdir -p "$lane/ws" "$lane/state"
tar -xf "$lane/src.tar" -C "$lane/ws"
rm "$lane/src.tar"
git -C "$lane/ws" init -q
git -C "$lane/ws" remote add origin https://github.com/giuseppecrj/pi-herdr-factorio.git
echo "$sha" > "$lane/head-sha"
(cd "$lane/ws" && npm ci --ignore-scripts --no-audit --no-fund 2>&1 | tail -2)
echo "lane=$lane sha=$sha"
