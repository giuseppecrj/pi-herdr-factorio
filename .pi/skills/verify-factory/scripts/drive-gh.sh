#!/usr/bin/env bash
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
export GH_HOST=github.int.exe.xyz
pr="$1"; n="$2"
require_lane_ids "$pr" "$n" || exit 2
repo=giuseppecrj/pi-herdr-factorio
lane="/home/exedev/factory-verification/$pr-w$n"
out="/tmp/swarm-$pr/worker-$n"
mkdir -p "$out"
rm -f "$out/gh-evidence.txt" "$out/repo.json" "$out/labels.txt" "$out/issues.json"
start="$(date -u +%FT%TZ)"
sha="$(cat "$lane/head-sha" 2>/dev/null || echo unknown)"
cmds=""
overall=0
run() {
  local dest="$1"; shift
  "$@" > "$dest"
  local rc=$?
  cmds="$cmds
command=$* exit=$rc"
  [ "$rc" -eq 0 ] || overall=$rc
}
missing=""
finish() {
  {
    echo "feature=gh-repo-reads"
    echo "head_sha=$sha"
    echo "GH_HOST=$GH_HOST repo=$repo"
    echo "started=$start"
    echo "ended=$(date -u +%FT%TZ)"
    echo "expected=repo view succeeds; labels include factory:ready factory:review factory:needs-info factory:proposed"
    printf '%s\n' "${cmds#?}"
    echo "missing_labels=${missing:-none}"
    echo "exit=$final"
  } > "$out/gh-evidence.txt"
  cat "$out/gh-evidence.txt"
  [ -f "$out/labels.txt" ] && cat "$out/labels.txt"
  exit "$final"
}
run "$out/repo.json" gh repo view "$repo" --json nameWithOwner,defaultBranchRef
run "$out/labels.raw" gh label list -R "$repo" --limit 100 --json name --jq '.[].name'
run "$out/issues.json" gh issue list -R "$repo" --state all --limit 5 --json number,title,state
sort "$out/labels.raw" > "$out/labels.txt" 2>/dev/null; rm -f "$out/labels.raw"
for l in factory:ready factory:review factory:needs-info factory:proposed; do
  grep -qx "$l" "$out/labels.txt" || missing="$missing $l"
done
final=$overall
[ "$final" -ne 0 ] || [ -z "$missing" ] || final=1
finish
