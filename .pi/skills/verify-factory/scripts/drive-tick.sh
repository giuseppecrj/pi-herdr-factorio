#!/usr/bin/env bash
# One controller tick on the lane: tick --once over the scoped issues, or
# run --issue for one issue. Prints the claim snapshot and the markers.
# Usage: vm.sh drive-tick.sh <pr-id> <worker-n> tick|run <issue>...
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
export GH_HOST=github.int.exe.xyz
pr="$1"; n="$2"; mode="${3:-}"; shift 3 || true
require_lane_ids "$pr" "$n" || exit 2
case "$mode" in tick|run) ;; *) echo "usage: drive-tick.sh <pr-id> <worker-n> tick|run <issue>..." >&2; exit 2;; esac
[ "$#" -ge 1 ] || { echo "name at least one issue: lanes never tick the whole repository" >&2; exit 2; }
[ "$mode" = tick ] || [ "$#" -eq 1 ] || { echo "run takes exactly one issue" >&2; exit 2; }
for issue in "$@"; do
  case "$issue" in ""|0*|*[!0-9]*) printf 'refusing issue: %q\n' "$issue" >&2; exit 2;; esac
done
repo=giuseppecrj/pi-herdr-factorio
lane="/home/exedev/factory-verification/$pr-w$n"
out="/tmp/swarm-$pr/worker-$n"
mkdir -p "$out"
[ -f "$lane/ws/server/cli.ts" ] || { echo "server/cli.ts missing from lane workspace" >&2; exit 2; }
chmod 700 "$lane/state"
sha="$(cat "$lane/head-sha" 2>/dev/null || echo unknown)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
args=()
for issue in "$@"; do args+=(--issue "$issue"); done
if [ "$mode" = tick ]; then cmd=(node server/cli.ts tick --once --json --repo "$repo" --state-dir "$lane/state" "${args[@]}")
else cmd=(node server/cli.ts run --json --repo "$repo" --state-dir "$lane/state" "${args[@]}"); fi
start="$(date -u +%FT%TZ)"
t0=$(date +%s%N)
(cd "$lane/ws" && "${cmd[@]}") > "$out/$mode-$stamp.json" 2> "$out/$mode-$stamp.log"
rc=$?
ms=$(( ($(date +%s%N) - t0) / 1000000 ))
summary=$(node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (r.error) { console.log("error=" + r.error + " pid=" + r.pid); process.exit(0); }
const runs = r.runs.map((x) => `#${x.issue}:${x.status}@${x.stage}/a${x.attempt}/seq${x.seq}/${x.runId.slice(0, 12)}/${x.workspace}`).join(",") || "none";
console.log(`dispatch=${r.dispatch.enabled} reasons=${r.dispatch.reasons.join("+") || "none"} runs=${runs} queued=${r.queued.join("+") || "none"} absent=${r.absent.join("+") || "none"} refused=${r.refused.map((x) => "#" + x.issue + ":" + x.reasons.join("+")).join(",") || "none"} corrupt=${r.corrupt.map((x) => "#" + x.issue + ":" + x.defect).join(",") || "none"} markersPosted=${r.totals.markersPosted} executionEnabled=${r.executionEnabled}`);
' "$out/$mode-$stamp.json" 2>/dev/null || echo unparsable)
markers=""
for issue in "$@"; do
  m=$(gh api "repos/$repo/issues/$issue/comments?per_page=100&page=1" --jq '[.[] | select(.user.login == "exe-dev-github-integration[bot]") | select(.body | startswith("<!-- factory:run ")) | (.body | capture("^<!-- factory:run (?<j>.*) -->").j | fromjson) | "\(.seq):\(.status):\(.runId[0:12])"] | join(",")' 2>/dev/null || echo unreadable)
  markers="$markers #$issue=[$m]"
done
{
  echo "feature=$mode"
  echo "head_sha=$sha"
  echo "GH_HOST=$GH_HOST repo=$repo state=$lane/state"
  echo "started=$start"
  echo "ended=$(date -u +%FT%TZ)"
  echo "expected=exit 0 for tick; run exits 0 when the issue holds a run and 1 otherwise; exit 2 with controller_running when another controller holds the lock"
  echo "command=${cmd[*]} exit=$rc ms=$ms"
  echo "$summary"
  echo "markers:$markers"
  echo "log:"
  sed 's/^/  /' "$out/$mode-$stamp.log"
} | tee "$out/$mode-$stamp-evidence.txt"
exit 0
