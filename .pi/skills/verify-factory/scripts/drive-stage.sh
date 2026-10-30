#!/usr/bin/env bash
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
export GH_HOST=github.int.exe.xyz
export XDG_RUNTIME_DIR=/run/user/1000
pr="$1"; n="$2"; issue="${3:-}"; mode="${4:-pass}"
require_lane_ids "$pr" "$n" || exit 2
usage="usage: drive-stage.sh <pr-id> <worker-n> <issue> [unavailable]"
case "$issue" in ""|0*|*[!0-9]*) echo "$usage" >&2; exit 2;; esac
case "$mode" in pass|unavailable) ;; *) echo "$usage" >&2; exit 2;; esac
repo=giuseppecrj/pi-herdr-factorio
lane="/home/exedev/factory-verification/$pr-w$n"
out="/tmp/swarm-$pr/worker-$n"
mkdir -p "$out"
[ -f "$lane/ws/server/cli.ts" ] || { echo "server/cli.ts missing from lane workspace" >&2; exit 2; }
chmod 700 "$lane/state"
sha="$(cat "$lane/head-sha" 2>/dev/null || echo unknown)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
bundle="$(readlink /var/lib/factory-sandbox/current 2>/dev/null || echo none)"
since="$out/.stage-$stamp.since"
touch "$since"
cli_path="$PATH"
if [ "$mode" = unavailable ]; then
  mkdir -p "$out/nobwrap"
  printf '#!/bin/sh\nexit 1\n' > "$out/nobwrap/bwrap"
  chmod 755 "$out/nobwrap/bwrap"
  cli_path="$out/nobwrap:$PATH"
fi
cmd=(node server/cli.ts tick --once --json --repo "$repo" --state-dir "$lane/state" --issue "$issue")
start="$(date -u +%FT%TZ)"
t0=$(date +%s%N)
(cd "$lane/ws" && PATH="$cli_path" "${cmd[@]}") > "$out/stage-$stamp.json" 2> "$out/stage-$stamp.log"
rc=$?
ms=$(( ($(date +%s%N) - t0) / 1000000 ))
runs=$(node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (r.error) { console.log("error=" + r.error); process.exit(0); }
const runs = r.runs.map((x) => `#${x.issue}:${x.status}@${x.stage}/a${x.attempt}/seq${x.seq}`).join(",") || "none";
console.log(`dispatch=${r.dispatch.enabled} reasons=${r.dispatch.reasons.join("+") || "none"} runs=${runs} executionEnabled=${r.executionEnabled} markersPosted=${r.totals.markersPosted} usage=${r.totals.usage}`);
' "$out/stage-$stamp.json" 2>/dev/null || echo unparsable)
markers=$(gh api "repos/$repo/issues/$issue/comments?per_page=100&page=1" --jq '[.[] | select(.user.login == "exe-dev-github-integration[bot]") | select(.body | startswith("<!-- factory:run ")) | (.body | capture("^<!-- factory:run (?<j>.*) -->").j | fromjson) | "\(.seq):\(.status):\(.runId[0:12])"] | join(",")' 2>/dev/null || echo unreadable)
receipts=""
for receipt in $(find "$lane/state/stages" -name receipt.json -newer "$since" 2>/dev/null | sort); do
  dir="$(dirname "$receipt")"
  name="$(basename "$(dirname "$dir")" | cut -c1-12)-$(basename "$dir")"
  cp "$receipt" "$out/receipt-$name-$stamp.json"
  line=$(node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const o = r.outcome;
const why = o.exit ?? o.cap ?? "";
const fb = r.fallback === null ? "none" : `${r.fallback.requested}:${r.fallback.outcome.kind}`;
const err = r.stderr.map((s) => `${s.session}:${s.file}:${s.bytes}`).join(",") || "none";
console.log(`outcome=${o.kind}${why === "" ? "" : ":" + why} settlement=${r.settlement.event}:aborted=${r.settlement.aborted} requested=${r.models.requested} observed=${r.models.observed} fallback=${fb} refusal=${r.refusal} wallMs=${r.wallMs} turns=${r.turns} usage=${r.usage.total} parent=${r.usage.parent} children=${r.usage.children} gateway=${r.usage.gateway} assets=${r.assetsDigest} pi=${r.versions.pi} pricing=${r.pricing} stderr=${err}`);
' "$receipt" 2>/dev/null || echo unparsable)
  egress=$(node -e '
const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
console.log(lines.map((l) => { const a = JSON.parse(l); return `${a.route}:${a.method}:${a.status}:${a.decision}:${a.reason}`; }).join(",") || "none");
' "$dir/egress.jsonl" 2>/dev/null || echo unreadable)
  files=""
  for f in "$dir"/pi-stderr-*.log; do
    [ -f "$f" ] && files="$files $(basename "$f"):$(stat -c '%a:%s' "$f"):$(sha256sum "$f" | cut -c1-12)"
  done
  receipts="$receipts
  receipt=$name mode=$(stat -c %a "$receipt")
    $line
    egress=$egress
    stderr_files=${files# }"
done
rm -f "$since"
scopes=$(systemctl --user list-units --all --no-legend 'factory-stage-*' 2>&1 | wc -l)
leftover=$(pgrep -u exedev -f 'bwrap|gateway-main|herdr --session factory' | wc -l)
{
  echo "feature=sandbox-stage mode=$mode"
  echo "head_sha=$sha"
  echo "GH_HOST=$GH_HOST repo=$repo state=$lane/state bundle=$bundle"
  echo "started=$start"
  echo "ended=$(date -u +%FT%TZ)"
  if [ "$mode" = unavailable ]; then
    echo "expected=exit 0; a bwrap that exits 1 fails the preflight: sandbox_preflight ok=false failed=bwrap, executionEnabled=false, the run blocked at specify, no receipt, no model call"
  else
    echo "expected=exit 0; with the preflight passing, markers claimed, running, then stage_passed with a contract summary or needs_info with a questions comment in this one tick, one receipt with outcome=passed, settlement agent_settled aborted=false, assets equal to the bundle digest, model egress forwarded, stderr byte counts only; no stage scope or sandbox process left"
  fi
  echo "command=${cmd[*]} exit=$rc ms=$ms"
  echo "$runs"
  echo "markers: #$issue=[$markers]"
  echo "receipts:${receipts:- none}"
  echo "leftover_scopes=$scopes leftover_processes=$leftover"
  echo "log:"
  sed 's/^/  /' "$out/stage-$stamp.log"
} | tee "$out/stage-$stamp-evidence.txt"
exit 0
