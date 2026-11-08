#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
export GH_HOST=github.int.exe.xyz
: "${FIXTURE_GRANT:?name the owner grant for fixtures, spend, production stop and installed bundle selection}"
: "${REPLAY_CONTROL_CHECKOUT:?use a clean frozen-main control checkout}"
: "${REPLAY_MAIN_SHA:?name frozen main}"
pr="${1:-}"; n="${2:-}"; mode="${3:-}"; issue="${4:-}"
control="$(realpath "$REPLAY_CONTROL_CHECKOUT")"
bootstrap=false
if [[ "${4:-}" == --bootstrap-candidate || "${5:-}" == --bootstrap-candidate ]]; then bootstrap=true; fi
trusted="$REPLAY_MAIN_SHA"
if $bootstrap; then
  : "${REPLAY_CANDIDATE_SHA:?name the bootstrap candidate}"
  trusted="$REPLAY_CANDIDATE_SHA"
fi
[[ "$(git -C "$control" rev-parse HEAD)" == "$trusted" ]] || { echo "control checkout does not match trusted pin" >&2; exit 2; }
[[ "$(realpath "${BASH_SOURCE[0]}")" == "$control/.pi/skills/verify-factory/scripts/drive-replay.sh" ]] || { echo "invoke the driver from the trusted control checkout" >&2; exit 2; }
git -C "$control" diff --quiet HEAD -- || { echo "control checkout is dirty" >&2; exit 2; }
grant_row="$(awk -F '\t' -v id="$FIXTURE_GRANT" '$2 == id { print }' "$control/docs/decisions.tsv")"
[[ -n "$grant_row" ]] || { echo "FIXTURE_GRANT is not a recorded owner decision" >&2; exit 2; }
source "$control/.pi/skills/verify-factory/scripts/lane-id.sh"
require_lane_ids "$pr" "$n"
[[ "$pr" == F12a-replay-* ]] || { echo "replay requires an F12a-replay- lane" >&2; exit 2; }
repo=giuseppecrj/pi-herdr-factorio
root="${REPLAY_ROOT:-/home/exedev/factory-verification}"
lane="$root/$pr-w$n"
out="${REPLAY_OUTPUT_ROOT:-/tmp/swarm-$pr/worker-$n}"
budget="$root/replay-budget.json"
pidfile="$lane/serve.pid"
record="$lane/replay.json"
recovery="$root/replay-restore.json"
production="$HOME/factory-state"
sandbox="${REPLAY_SANDBOX_ROOT:-/var/lib/factory-sandbox}"
cd "$control"

# Read exact argv, not a substring or just a live PID (which may have been reused).
alive() { [[ -r "/proc/$1/stat" ]] && [[ "$(awk '{print $3}' "/proc/$1/stat")" != Z ]]; }
owned() {
  node --input-type=module - "$1" "$lane/state" <<'NODE'
import { readFileSync } from 'node:fs';
const [pid, state] = process.argv.slice(2);
try {
  const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  const at = args.indexOf('--state-dir');
  process.exit(args.includes('server/cli.ts') && args.includes('serve') && at >= 0 && args[at + 1] === state ? 0 : 1);
} catch { process.exit(1); }
NODE
}
stop_child() {
  [[ -s "$pidfile" ]] || return 0
  local pid
  pid="$(<"$pidfile")"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  if alive "$pid"; then
    owned "$pid" || { echo "recorded PID is not this lane's serve; refusing signal" >&2; return 1; }
    kill -TERM "$pid"
    for _ in $(seq 1 1200); do alive "$pid" || return 0; sleep 0.1; done
    echo "replay=still_running pid=$pid" >&2
    return 1
  fi
}
main_pin() { gh api "repos/$repo/commits/main" --jq .sha; }
production_free() {
  node --input-type=module - "$production" <<'NODE'
import { readFile, readdir, stat } from 'node:fs/promises';
import { readLock } from './server/controller.ts';
const state = process.argv[2];
const lock = await readLock(state);
console.log(`production=${lock.kind}`);
if (!['none', 'holder_file_without_socket'].includes(lock.kind)) throw Error('production_controller_running');
for (const name of await readdir('/proc')) {
  if (!/^\d+$/.test(name)) continue;
  let args;
  try {
    if ((await stat(`/proc/${name}`)).uid !== process.getuid()) continue;
    args = (await readFile(`/proc/${name}/cmdline`, 'utf8')).split('\0');
  }
  catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
  if (args.includes('serve') && args.includes('--state-dir') && args[args.indexOf('--state-dir') + 1] === state)
    throw Error('production_controller_process_remains');
}
NODE
}
settle() {
  local terminal
  terminal="$(main_pin)" || terminal=""
  node --input-type=module - "$budget" "$lane/state" "$record" "$out/serve.log" "$terminal" <<'NODE'
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { replayRow, settleReplay, voidReplay, readReplayRecord, readReplayBudget } from './src/replay.ts';
import { readDurableAccounting } from './server/controller.ts';
import { digestOf } from './src/run.ts';
const [budget, state, path, log, terminal] = process.argv.slice(2);
const raw = JSON.parse(await readFile(path, 'utf8'));
const record = readReplayRecord(JSON.stringify(raw));
const entries = async dir => readdir(dir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
const rows = (await entries(join(state, 'ledger'))).filter(name => /^[a-f0-9]{64}$/.test(name));
const accounting = await readDurableAccounting(state, 'giuseppecrj/pi-herdr-factorio');
const stageDirs = await entries(join(state, 'stages'));
const text = await readFile(log, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
const reservation = (await readReplayBudget(budget)).reservations.find(r => r.key === state);
let status = reservation?.status ?? 'not_reserved';
let reason = 'terminal_accounting_unavailable';
let runId = record.runId;
const row = rows.length === 1 ? replayRow(await readFile(join(state, 'ledger', rows[0], 'row.json'))) : null;
if (row !== null) {
  const manifest = await readFile(join(state, 'verification.json'), 'utf8');
  if (row.provenance.verificationDigest !== digestOf(manifest) || row.issue !== record.issue) throw Error('replay_manifest_mismatch');
  runId = row.runId;
}
const zeroRow = row === null || (row.usage.tokens.kind === 'exact' && row.usage.tokens.total === 0 && row.stages.kind === 'known' && row.stages.value.length === 0);
if (reservation !== undefined && rows.length <= 1 && zeroRow && stageDirs.length === 0 && !text.includes('event=stage_launched') && accounting.state === 'readable' && accounting.runs.every(r => r.executions === 0 && r.tokens.total === 0 && r.readable)) {
  reason = 'no_stage_executed_zero_usage';
  await voidReplay(budget, state, { stages: 0, tokens: 0, complete: true }, reason);
  status = 'voided';
} else if (row !== null) {
  await settleReplay(budget, state, row);
  status = 'settled';
  reason = row.outcome.kind;
}
const next = { ...raw, runId, terminalMainSha: /^[a-f0-9]{40}$/.test(terminal) ? terminal : null, status, reason };
await writeFile(`${path}.tmp`, `${JSON.stringify(next, null, 2)}\n`, {mode:0o600});
await rename(`${path}.tmp`, path);
console.log(`replay=${status} reason=${reason}`);
NODE
}

warn_hold() {
  if [[ -e "$production/disabled" || -L "$production/disabled" ]]; then
    echo "WARNING: production is still on hold at $production/disabled; confirm the original bundle and fixture disarming before changing it" >&2
  fi
}
recovery_warning() {
  echo "WARNING: unfinished production restoration; refusing a new replay. Recovery file: $recovery" >&2
  node --input-type=module - "$recovery" <<'NODE'
import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const q = s => "'" + String(s).replaceAll("'", "'\\''") + "'";
const vars = { FIXTURE_GRANT:r.grant, REPLAY_CONTROL_CHECKOUT:r.control, REPLAY_MAIN_SHA:r.mainSha, REPLAY_CANDIDATE_SHA:r.trusted, REPLAY_ROOT:r.root, REPLAY_SANDBOX_ROOT:r.sandbox, REPLAY_OUTPUT_ROOT:r.out };
console.error('Keep the hold in place. Run: ' + Object.entries(vars).map(([k,v]) => k + '=' + q(v)).join(' ') + ' bash ' + q(r.control + '/.pi/skills/verify-factory/scripts/drive-replay.sh') + ' ' + q(r.pr) + ' ' + q(r.n) + ' stop' + (r.bootstrap ? ' --bootstrap-candidate' : ''));
NODE
  warn_hold
}
restore_window() {
  local original settled=true safe=true code=0
  original="$(node --input-type=module - "$recovery" "$lane" "$production" "$sandbox" <<'NODE'
import { readFileSync } from 'node:fs';
const [path, lane, production, sandbox] = process.argv.slice(2);
const r = JSON.parse(readFileSync(path, 'utf8'));
if (r.v !== 1 || r.lane !== lane || r.production !== production || r.sandbox !== sandbox || !/^assets-[a-f0-9]{64}$/.test(r.oldBundle) || !['active','inactive','failed'].includes(r.serviceState) || typeof r.hadHold !== 'boolean' || !Number.isSafeInteger(r.issue) || r.issue < 1 || r.fixtureLabel !== 'factory:ready' || typeof r.out !== 'string' || r.out.includes('\n')) throw Error('restore_record_mismatch');
console.log([r.oldBundle, r.serviceState, r.hadHold, r.issue, r.out].join('\n'));
NODE
)" || return 1
  local -a saved
  mapfile -t saved <<<"$original"
  local old_bundle="${saved[0]}" service_state="${saved[1]}" had_hold="${saved[2]}" issue="${saved[3]}"
  out="${saved[4]}"
  # Recovery may run after a manual service restart. Hold and stop it first.
  if [[ ! -e "$production/disabled" && ! -L "$production/disabled" ]]; then touch "$production/disabled" || return 1; fi
  sudo systemctl stop factory.service || return 1
  case "$(systemctl is-active factory.service || true)" in inactive|failed) ;; *) return 1;; esac
  if stop_child; then
    if [[ -f "$record" ]]; then settle || { settled=false; code=1; }; fi
    if $settled; then rm -f "$pidfile" || code=1; fi
    gh issue edit "$issue" --repo "$repo" --remove-label factory:ready >"$out/disarm.log" 2>&1 || safe=false
    gh issue view "$issue" --repo "$repo" --json labels >"$out/stopped-fixture.json" || safe=false
    node --input-type=module - "$out/stopped-fixture.json" <<'NODE' || safe=false
import { readFile } from 'node:fs/promises';
const issue = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (!Array.isArray(issue.labels) || issue.labels.some(l => l.name === 'factory:ready')) throw Error('fixture_still_ready');
NODE
    if [[ "$(readlink "$sandbox/current")" != "$old_bundle" ]]; then
      sudo ln -sfn "$old_bundle" "$sandbox/current" || safe=false
    fi
    if $safe; then
      if ! $had_hold; then rm -f "$production/disabled" || code=1; fi
      if [[ "$service_state" == active ]]; then
        sudo systemctl start factory.service || { touch "$production/disabled"; code=1; }
      fi
    else
      echo "production restoration blocked: fixture or bundle could not be restored; hold retained" >&2
      code=1
    fi
  else
    echo "replay stop failed; production held for safety" >&2
    code=1
  fi
  if [[ "$code" == 0 ]]; then
    rm "$recovery" || return 1
    echo "replay=window_closed grant=$FIXTURE_GRANT bootstrap=$bootstrap"
  fi
  warn_hold
  return "$code"
}
restore() {
  local code=$?
  trap - EXIT
  trap '' INT TERM HUP
  restore_window || { recovery_warning; code=1; }
  exit "$code"
}

if [[ -e "$recovery" && "$mode" != stop ]]; then recovery_warning; exit 2; fi

case "$mode" in
  start)
    : "${REPLAY_CASE:?name a pinned case}"
    : "${REPLAY_SIDE:?previous or candidate}"
    : "${REPLAY_PREVIOUS_SHA:?name previous trusted factory}"
    : "${REPLAY_CANDIDATE_SHA:?name candidate factory}"
    : "${REPLAY_PREVIOUS_ASSETS:?name the installed previous bundle digest}"
    : "${REPLAY_CANDIDATE_ASSETS:?name the installed candidate bundle digest}"
    case "$issue" in ""|0*|*[!0-9]*) echo "name one fixture issue" >&2; exit 2;; esac
    case "$REPLAY_SIDE" in previous) expected="$REPLAY_PREVIOUS_SHA"; assets="$REPLAY_PREVIOUS_ASSETS";; candidate) expected="$REPLAY_CANDIDATE_SHA"; assets="$REPLAY_CANDIDATE_ASSETS";; *) exit 2;; esac
    [[ "$assets" =~ ^[a-f0-9]{64}$ ]] || exit 2
    [[ "$(<"$lane/head-sha")" == "$expected" ]] || { echo "lane head does not match side pin" >&2; exit 2; }
    [[ ! -e "$pidfile" && ! -e "$record" && ! -L "$lane/state" && -d "$lane/state" && -z "$(find "$lane/state" -mindepth 1 -print -quit)" ]] || { echo "replay needs fresh isolated state" >&2; exit 2; }
    exec 9>"$root/replay-driver.lock"
    flock -n 9 || { echo "another replay controller is active" >&2; exit 2; }
    [[ "$(main_pin)" == "$REPLAY_MAIN_SHA" ]] || { echo "main pin moved; freeze main" >&2; exit 2; }
    mkdir -p "$out"
    printf '%s\n' "$grant_row" >"$out/grant.tsv"
    gh issue view "$issue" --repo "$repo" --json title,body,state,labels,comments >"$out/fixture.json"
    node --input-type=module - "$out/fixture.json" "$REPLAY_CASE" <<'NODE'
import { readFile } from 'node:fs/promises';
import { loadReplayCorpus, REPLAY_CORPUS } from './src/replay.ts';
const [path, id] = process.argv.slice(2);
const c = (await loadReplayCorpus(REPLAY_CORPUS)).cases.find(c => c.id === id);
const issue = JSON.parse(await readFile(path, 'utf8'));
if (!c || issue.title !== c.title) throw Error('not_the_pinned_fixture_title');
if (issue.body !== await readFile(`${REPLAY_CORPUS}/cases/${id}/issue.md`, 'utf8')) throw Error('fixture_body_mismatch');
if (issue.state !== 'OPEN' || !issue.labels.some(l => l.name === 'factory:ready')) throw Error('fixture_not_ready');
if (issue.comments.some(c => c.body.includes('<!-- factory:run'))) throw Error('use a fresh fixture issue; prior controller marker exists');
NODE
    service_state="$(systemctl is-active factory.service || true)"
    case "$service_state" in active|inactive|failed) ;; *) echo "production service state unavailable" >&2; exit 2;; esac
    old_bundle="$(readlink "$sandbox/current")"
    [[ "$old_bundle" =~ ^assets-[a-f0-9]{64}$ ]] || exit 2
    had_hold=false
    [[ -e "$production/disabled" || -L "$production/disabled" ]] && had_hold=true
    # Sync original state before any hold, stop or bundle mutation. Keep it until recovery completes.
    node --input-type=module - "$recovery" "$old_bundle" "$service_state" "$had_hold" "$issue" "$lane" "$production" "$sandbox" "$out" "$pr" "$n" "$trusted" "$bootstrap" <<'NODE'
import { open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
const [path, oldBundle, serviceState, hadHold, issue, lane, production, sandbox, out, pr, n, trusted, bootstrap] = process.argv.slice(2);
const r = {v:1, oldBundle, serviceState, hadHold:hadHold === 'true', issue:Number(issue), fixtureLabel:'factory:ready', lane, production, sandbox, out, pr, n, trusted, bootstrap:bootstrap === 'true', control:process.cwd(), mainSha:process.env.REPLAY_MAIN_SHA, grant:process.env.FIXTURE_GRANT, root:dirname(path)};
const file = await open(`${path}.tmp`, 'w', 0o600);
try { await file.writeFile(JSON.stringify(r, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
await rename(`${path}.tmp`, path);
const dir = await open(dirname(path), 'r');
try { await dir.sync(); } finally { await dir.close(); }
NODE
    trap restore EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM HUP
    # Explicit systemctl stop cancels Restart=on-failure; hold precedes that stop.
    if ! $had_hold; then touch "$production/disabled"; fi
    sudo systemctl stop factory.service
    case "$(systemctl is-active factory.service || true)" in inactive|failed) ;; *) echo "production stop failed" >&2; exit 1;; esac
    production_free
    sudo ln -sfn "assets-$assets" "$sandbox/current"
    node server/cli.ts replay check --json --case "$REPLAY_CASE" --main-sha "$REPLAY_MAIN_SHA" --previous-sha "$REPLAY_PREVIOUS_SHA" --candidate-sha "$REPLAY_CANDIDATE_SHA" --production-state-dir "$production" --budget-file "$budget" --bundle-root "$sandbox" --previous-assets "$REPLAY_PREVIOUS_ASSETS" --candidate-assets "$REPLAY_CANDIDATE_ASSETS" --side "$REPLAY_SIDE" >"$out/replay-check.json"
    # Preflight executes trusted-main code, not either factory's implementation.
    node --input-type=module - "$lane/preflight" "$sandbox" <<'NODE'
import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sandboxExecutor } from './server/sandbox.ts';
const run = promisify(execFile);
const [stateDir, root] = process.argv.slice(2);
await mkdir(stateDir, {recursive:true, mode:0o700});
const exec = async (cmd, args) => { try { const r = await run(cmd, args); return {code:0, ...r}; } catch (e) { return {code:1, stdout:e.stdout ?? '', stderr:e.stderr ?? ''}; } };
const executor = sandboxExecutor({stateDir, root, exec, log: (event, data) => console.log(event, JSON.stringify(data))});
if (!(await executor.preflight())) throw Error('replay_preflight_failed');
NODE
    production_free
    [[ "$(main_pin)" == "$REPLAY_MAIN_SHA" ]] || { echo "main pin moved" >&2; exit 2; }
    node --input-type=module - "$budget" "$lane/state" "$record" "$expected" "$trusted" "$bootstrap" "$issue" <<'NODE'
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { parseWorkflow, isRepoSlug } from './src/workflow.ts';
import { loadReplayCorpus, reserveReplay, replayStageCaps, REPLAY_CORPUS } from './src/replay.ts';
const [path, key, record, headSha, controlSha, bootstrap, issue] = process.argv.slice(2);
const mainSha = process.env.REPLAY_MAIN_SHA;
const repo = 'giuseppecrj/pi-herdr-factorio';
if (!isRepoSlug(repo)) throw Error('repository');
const text = execFileSync('git', ['show', `${mainSha}:.github/factory/WORKFLOW.md`], {encoding:'utf8'});
const parsed = parseWorkflow({text, repo, env:name => process.env[name]});
if (parsed.kind !== 'valid' || parsed.config.replay == null) throw Error('replay_disabled');
const corpus = await loadReplayCorpus(REPLAY_CORPUS);
const c = corpus.cases.find(c => c.id === process.env.REPLAY_CASE);
if (!c) throw Error('replay_case_unknown');
const exec = async (cmd, args) => ({code:0, stdout:execFileSync(cmd, args, {encoding:'utf8'}), stderr:''});
const stageCaps = await replayStageCaps(headSha, exec);
await writeFile(record, `${JSON.stringify({v:1, caseId:c.id, corpusDigest:corpus.digest, issueDigest:c.issueDigest, side:process.env.REPLAY_SIDE === 'previous' ? 'prev' : 'cand', issue:Number(issue), headSha, mainSha, terminalMainSha:null, runId:null, stageCaps, controlSha, bootstrap:bootstrap === 'true', grant:process.env.FIXTURE_GRANT, status:'prepared'}, null, 2)}\n`, {mode:0o600, flag:'wx'});
await reserveReplay(path, parsed.config.replay.maxTokens, key);
NODE
    chmod 700 "$lane/state"
    (cd "$lane/ws" && exec node server/cli.ts serve --repo "$repo" --state-dir "$lane/state" --issue "$issue" --verification-token-cap 540000 9>&9 >/dev/null 2>>"$out/serve.log" </dev/null) &
    pid=$!
    echo "$pid" >"$pidfile"
    for _ in $(seq 1 120); do
      if grep -q "event=controller_ready pid=$pid " "$out/serve.log"; then
        echo "replay=ready pid=$pid grant=$FIXTURE_GRANT bootstrap=$bootstrap budget=$budget"
        wait "$pid"
        exit $?
      fi
      alive "$pid" || { wait "$pid"; exit 1; }
      sleep 0.1
    done
    echo "replay=not_ready" >&2
    exit 1
    ;;
  stop)
    trap warn_hold EXIT
    [[ -s "$pidfile" || -e "$recovery" ]] || { echo "no recorded replay PID" >&2; exit 2; }
    stop_child || { if [[ -e "$recovery" ]]; then recovery_warning; fi; exit 1; }
    exec 9>"$root/replay-driver.lock"
    flock -w 150 9 || { echo "another replay holds the budget; retry stop" >&2; exit 2; }
    if [[ -e "$recovery" ]]; then
      trap '' INT TERM HUP
      restore_window || { recovery_warning; exit 1; }
    elif [[ -s "$pidfile" ]]; then
      settle; rm "$pidfile"
    fi
    echo "replay=stopped budget=$budget"
    ;;
  *) echo "usage: drive-replay.sh <F12a-replay-id> <n> start <issue> [--bootstrap-candidate] | stop" >&2; exit 2;;
esac
