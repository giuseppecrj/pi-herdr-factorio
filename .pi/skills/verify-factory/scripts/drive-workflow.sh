#!/usr/bin/env bash
# Remote, read-only. Run: scripts/vm.sh scripts/drive-workflow.sh <pr-id> <worker-n> [ref...]
# Runs `server/cli.ts workflow-check --json` and `status --json` in the lane
# workspace for main and each extra ref. Saves evidence under
# /tmp/swarm-<pr-id>/worker-<n>/.
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
export GH_HOST=github.int.exe.xyz
pr="$1"; n="$2"; shift 2
require_lane_ids "$pr" "$n" || exit 2
for ref in "$@"; do
  case "$ref" in ""|-*|*..*|*[!A-Za-z0-9._/-]*) printf 'refusing ref: %q\n' "$ref" >&2; exit 2;; esac
done
repo=giuseppecrj/pi-herdr-factorio
lane="/home/exedev/factory-verification/$pr-w$n"
out="/tmp/swarm-$pr/worker-$n"
mkdir -p "$out"
rm -f "$out"/workflow-check-*.json "$out"/status-*.json "$out/workflow-evidence.txt"
[ -f "$lane/ws/server/cli.ts" ] || { echo "server/cli.ts missing from lane workspace" >&2; exit 2; }
sha="$(cat "$lane/head-sha" 2>/dev/null || echo unknown)"
start="$(date -u +%FT%TZ)"
lines=""
final=0
field() {
  node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k],r);console.log(v===undefined?"undefined":JSON.stringify(v))' "$1" "$2" 2>/dev/null || echo unparsable
}
for ref in main "$@"; do
  name="${ref//\//_}"
  (cd "$lane/ws" && node server/cli.ts workflow-check --json --repo "$repo" --ref "$ref") > "$out/workflow-check-$name.json"
  check=$?
  (cd "$lane/ws" && node server/cli.ts status --json --repo "$repo" --ref "$ref") > "$out/status-$name.json"
  status=$?
  f="$out/workflow-check-$name.json"; s="$out/status-$name.json"
  lines="$lines
command=node server/cli.ts workflow-check --json --repo $repo --ref $ref exit=$check valid=$(field "$f" valid) sha=$(field "$f" sha) digest=$(field "$f" digest) verification=$(field "$f" verification) error_kind=$(field "$f" error.kind) error_field=$(field "$f" error.field)
command=node server/cli.ts status --json --repo $repo --ref $ref exit=$status workflow=$(field "$s" workflow) workflowSha=$(field "$s" workflowSha) executionEnabled=$(field "$s" executionEnabled) controller=$(field "$s" controller.state) build_model=$(field "$s" models.build)"
  # Exit 2 is a usage error, which means this script is broken. status must always exit 0.
  { [ "$check" -le 1 ] && [ "$status" -eq 0 ]; } || final=1
done
{
  echo "feature=workflow-check,status-json"
  echo "head_sha=$sha"
  echo "GH_HOST=$GH_HOST repo=$repo"
  echo "node=$(node --version)"
  echo "started=$start"
  echo "ended=$(date -u +%FT%TZ)"
  echo "expected=workflow-check exits 0 with valid=true for a ref holding a valid WORKFLOW.md and 1 with an error kind otherwise; status exits 0 with executionEnabled=false and controller unavailable"
  printf '%s\n' "${lines#?}"
  echo "exit=$final"
} > "$out/workflow-evidence.txt"
cat "$out/workflow-evidence.txt"
exit "$final"
