#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
export GH_HOST=github.int.exe.xyz
pr="$1"; n="$2"
repo=giuseppecrj/pi-herdr-factorio
out="/tmp/swarm-$pr/worker-$n"
mkdir -p "$out"
start="$(date -u +%FT%TZ)"
gh repo view "$repo" --json nameWithOwner,defaultBranchRef > "$out/repo.json"
gh label list -R "$repo" --limit 100 --json name --jq '.[].name' | sort > "$out/labels.txt"
gh issue list -R "$repo" --state all --limit 5 --json number,title,state > "$out/issues.json"
missing=""
for l in factory:ready factory:review factory:needs-info factory:proposed; do
  grep -qx "$l" "$out/labels.txt" || missing="$missing $l"
done
{
  echo "feature=gh-repo-reads"
  echo "commands=gh repo view / gh label list / gh issue list (GH_HOST=$GH_HOST, -R $repo)"
  echo "started=$start"
  echo "ended=$(date -u +%FT%TZ)"
  echo "expected=repo view succeeds; labels include factory:ready factory:review factory:needs-info factory:proposed"
  echo "missing_labels=${missing:-none}"
} > "$out/gh-evidence.txt"
cat "$out/gh-evidence.txt"
cat "$out/labels.txt"
[ -z "$missing" ]
