#!/usr/bin/env bash
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
export GH_HOST=github.int.exe.xyz
pr="$1"; n="$2"; shift 2
require_lane_ids "$pr" "$n" || exit 2
[ "$#" -ge 1 ] || { echo "usage: drive-admit.sh <pr-id> <worker-n> <issue>..." >&2; exit 2; }
for issue in "$@"; do
  case "$issue" in ""|0*|*[!0-9]*) printf 'refusing issue: %q\n' "$issue" >&2; exit 2;; esac
done
repo=giuseppecrj/pi-herdr-factorio
lane="/home/exedev/factory-verification/$pr-w$n"
out="/tmp/swarm-$pr/worker-$n"
mkdir -p "$out"
rm -f "$out"/admission-*.json "$out/admit-evidence.txt"
[ -f "$lane/ws/server/cli.ts" ] || { echo "server/cli.ts missing from lane workspace" >&2; exit 2; }
sha="$(cat "$lane/head-sha" 2>/dev/null || echo unknown)"
start="$(date -u +%FT%TZ)"
lines=""
final=0
field() {
  node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k],r);console.log(v===undefined?"undefined":JSON.stringify(v))' "$1" "$2" 2>/dev/null || echo unparsable
}
for issue in "$@"; do
  f="$out/admission-$issue.json"
  t0=$(date +%s%N)
  (cd "$lane/ws" && node server/cli.ts admit --json --repo "$repo" --issue "$issue" --state-dir "$lane/state") > "$f"
  rc=$?
  ms=$(( ($(date +%s%N) - t0) / 1000000 ))
  reasons=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.reasons.map(x=>x.kind+(x.failure?"("+x.failure.kind+(x.failure.status?" "+x.failure.status:"")+")":"")+(x.detail?"("+x.detail+")":"")).join(",")||"none")' "$f" 2>/dev/null || echo unparsable)
  lines="$lines
command=node server/cli.ts admit --json --repo $repo --issue $issue --state-dir $lane/state exit=$rc ms=$ms decision=$(field "$f" decision) reasons=$reasons eventId=$(field "$f" eventId) actor=$(field "$f" actor) permission=$(field "$f" actorPermission) snapshotSource=$(field "$f" snapshotSource) snapshotDigest=$(field "$f" snapshotDigest) baseSha=$(field "$f" baseSha)"
  [ "$rc" -le 1 ] || final=1
done
{
  echo "feature=admit"
  echo "head_sha=$sha"
  echo "GH_HOST=$GH_HOST repo=$repo state=$lane/state"
  echo "node=$(node --version)"
  echo "started=$start"
  echo "ended=$(date -u +%FT%TZ)"
  echo "expected=exit 0 with decision admitted, or exit 1 with decision refused and explicit reasons; never exit 2; no model process"
  printf '%s\n' "${lines#?}"
  echo "exit=$final"
} > "$out/admit-evidence.txt"
cat "$out/admit-evidence.txt"
exit "$final"
