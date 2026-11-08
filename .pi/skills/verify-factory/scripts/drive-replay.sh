#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
export GH_HOST=github.int.exe.xyz
: "${FIXTURE_GRANT:?FIXTURE_GRANT must name the owner decision authorizing fixtures, model spend and the production stop}"
: "${REPLAY_CONTROL_CHECKOUT:?use the candidate control checkout with the pinned git objects}"
pr="${1:-}"; n="${2:-}"; mode="${3:-}"; issue="${4:-}"
# vm.sh normally provides this helper; sourcing also permits direct VM invocation.
if ! declare -F require_lane_ids >/dev/null; then
  source "$(dirname "${BASH_SOURCE[0]}")/lane-id.sh"
fi
require_lane_ids "$pr" "$n"
[[ "$pr" == F12a-replay-* ]] || { echo "replay requires an F12a-replay- lane" >&2; exit 2; }
repo=giuseppecrj/pi-herdr-factorio
root=/home/exedev/factory-verification
lane="$root/$pr-w$n"
out="/tmp/swarm-$pr/worker-$n"
budget="$root/replay-budget.json"
pidfile="$lane/serve.pid"
control="$REPLAY_CONTROL_CHECKOUT"
production="$HOME/factory-state"
cap=540000
cd "$control"
case "$mode" in
  start)
    : "${REPLAY_CASE:?name a pinned corpus case}"
    : "${REPLAY_SIDE:?previous or candidate}"
    [[ "$REPLAY_CASE" =~ ^c[1-9][0-9]*$ ]] || { echo "invalid corpus case" >&2; exit 2; }
    : "${REPLAY_MAIN_SHA:?name frozen main}"
    : "${REPLAY_PREVIOUS_SHA:?name the previous trusted factory}"
    : "${REPLAY_CANDIDATE_SHA:?name the candidate factory}"
    case "$issue" in ""|0*|*[!0-9]*) echo "name one fixture issue" >&2; exit 2;; esac
    case "$REPLAY_SIDE" in previous) expected="$REPLAY_PREVIOUS_SHA";; candidate) expected="$REPLAY_CANDIDATE_SHA";; *) exit 2;; esac
    [[ "$(<"$lane/head-sha")" == "$expected" ]] || { echo "lane head does not match side pin" >&2; exit 2; }
    [[ "$(git rev-parse refs/remotes/origin/main)" == "$REPLAY_MAIN_SHA" ]] || { echo "main pin moved; freeze main" >&2; exit 2; }
    title="$(gh issue view "$issue" --repo "$repo" --json title --jq .title)"
    [[ "$title" == "[F12a-replay-$REPLAY_CASE-$REPLAY_SIDE]"* ]] || { echo "not the named replay fixture" >&2; exit 2; }
    body="$(gh issue view "$issue" --repo "$repo" --json body --jq .body)"
    [[ "$body" == "$(<"test/fixtures/replay/cases/$REPLAY_CASE/issue.md")" ]] || { echo "fixture body differs from the pinned sanitized case" >&2; exit 2; }
    [[ ! -e "$pidfile" && -d "$lane/state" && -z "$(find "$lane/state" -mindepth 1 -print -quit)" ]] || { echo "replay needs fresh isolated state" >&2; exit 2; }
    exec 9>"$root/replay-driver.lock"
    flock -n 9 || { echo "another replay controller is active" >&2; exit 2; }
    mkdir -p "$out"
    node server/cli.ts replay check --json --case "$REPLAY_CASE" --main-sha "$REPLAY_MAIN_SHA" --previous-sha "$REPLAY_PREVIOUS_SHA" --candidate-sha "$REPLAY_CANDIDATE_SHA" --production-state-dir "$production" --budget-file "$budget" >"$out/replay-check.json"
    # The control checkout reads only the frozen main policy, never candidate WORKFLOW bytes.
    node --input-type=module - "$budget" "$lane/state" "$REPLAY_MAIN_SHA" <<'NODE'
import { execFileSync } from 'node:child_process';
import { parseWorkflow, isRepoSlug } from './src/workflow.ts';
import { reserveReplay } from './src/replay.ts';
const [path, key, sha] = process.argv.slice(2);
const repo = 'giuseppecrj/pi-herdr-factorio';
if (!isRepoSlug(repo)) throw Error('repository');
const text = execFileSync('git', ['show', `${sha}:.github/factory/WORKFLOW.md`], {encoding:'utf8'});
const parsed = parseWorkflow({ text, repo, env: name => process.env[name] });
if (parsed.kind !== 'valid' || parsed.config.replay == null) throw Error('replay_disabled');
await reserveReplay(path, parsed.config.replay.maxTokens, key);
NODE
    chmod 700 "$lane/state"
    (cd "$lane/ws" && exec setsid node server/cli.ts serve --repo "$repo" --state-dir "$lane/state" --issue "$issue" --verification-token-cap "$cap" 9>&9 >/dev/null 2>>"$out/serve.log" </dev/null) &
    pid=$!
    echo "$pid" >"$pidfile"
    for _ in $(seq 1 60); do
      if grep -q "event=controller_ready pid=$pid " "$out/serve.log"; then
        echo "replay=ready pid=$pid grant=$FIXTURE_GRANT budget=$budget"
        exit 0
      fi
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    echo "replay=not_ready reservation retained; inspect $out/serve.log and stop the recorded PID" >&2
    exit 1
    ;;
  stop)
    [[ -s "$pidfile" ]] || { echo "no recorded replay PID" >&2; exit 2; }
    pid="$(<"$pidfile")"
    case "$pid" in ""|*[!0-9]*) exit 2;; esac
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 120); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    if kill -0 "$pid" 2>/dev/null; then echo "replay=still_running pid=$pid" >&2; exit 1; fi
    rm "$pidfile"
    exec 9>"$root/replay-driver.lock"
    flock -n 9 || { echo "another replay holds the budget; reservation retained" >&2; exit 2; }
    node --input-type=module - "$budget" "$lane/state" <<'NODE'
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { replayRow, settleReplay } from './src/replay.ts';
import { digestOf } from './src/run.ts';
const [budget, state] = process.argv.slice(2);
const rows = [];
try {
  for (const name of await readdir(join(state, 'ledger'))) {
    if (/^[a-f0-9]{64}$/.test(name)) rows.push(join(state, 'ledger', name, 'row.json'));
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
if (rows.length === 1) {
  const row = replayRow(await readFile(rows[0]));
  const manifest = await readFile(join(state, 'verification.json'), 'utf8');
  if (row.provenance.verificationDigest !== digestOf(manifest)) throw Error('replay_manifest_mismatch');
  await settleReplay(budget, state, row);
} else console.log('replay=reservation_retained terminal accounting unavailable');
NODE
    echo "replay=stopped budget=$budget"
    ;;
  *) echo "usage: drive-replay.sh <F12a-replay-id> <worker-n> start <fixture-issue> | stop" >&2; exit 2;;
esac
