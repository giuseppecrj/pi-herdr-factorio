#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
if [ -z "${GH_HOST:-}" ]; then
  echo 'GH_HOST: run this driver on the VM as a file, not through vm.sh, after exporting that target'"'"'s GH_HOST from targets.env' >&2
  exit 2
fi
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
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
repo=nublai/pi-herdr-factorio
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

# Each step runs checked TypeScript from the trusted control checkout.
replay_step() { node "$control/.pi/skills/verify-factory/scripts/drive-replay.ts" "$@"; }
# Read exact argv, not a substring or just a live PID (which may have been reused).
alive() { [[ -r "/proc/$1/stat" ]] && [[ "$(awk '{print $3}' "/proc/$1/stat")" != Z ]]; }
owned() {
  replay_step owned "$1" "$lane/state"
}
stop_child() {
  [[ -s "$pidfile" ]] || return 0
  local pid
  pid="$(<"$pidfile")"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  if alive "$pid"; then
    owned "$pid" || { echo "recorded PID is not this lane's serve; refusing signal" >&2; return 1; }
    local limit_ms stop_polls
    limit_ms="$(replay_step visible-limit "$control/server/sandbox.ts")" && [[ "$limit_ms" =~ ^[1-9][0-9]*$ ]] \
      || { echo "visible-test deadline unavailable; refusing signal" >&2; return 1; }
    kill -TERM "$pid"
    # A failed candidate can be followed by a base run in the same tick.
    stop_polls=$(( (2 * limit_ms + 60000 + 99) / 100 ))
    for _ in $(seq 1 "$stop_polls"); do alive "$pid" || return 0; sleep 0.1; done
    echo "replay=still_running pid=$pid" >&2
    return 1
  fi
}
main_pin() { gh api "repos/$repo/commits/main" --jq .sha; }
production_free() {
  replay_step production-free "$production"
}
settle() {
  local terminal
  terminal="$(main_pin)" || terminal=""
  replay_step settle "$budget" "$lane/state" "$record" "$out/serve.log" "$terminal"
}

warn_hold() {
  if [[ -e "$production/disabled" || -L "$production/disabled" ]]; then
    echo "WARNING: production is still on hold at $production/disabled; confirm the original bundle and fixture disarming before changing it" >&2
  fi
}
recovery_warning() {
  echo "WARNING: unfinished production restoration; refusing a new replay. Recovery file: $recovery" >&2
  replay_step recovery-command "$recovery"
  warn_hold
}
restore_window() {
  local original settled=true safe=true code=0
  original="$(replay_step restore-fields "$recovery" "$lane" "$production" "$sandbox")" || return 1
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
    replay_step fixture-disarmed "$out/stopped-fixture.json" || safe=false
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
    replay_step fixture-ready "$out/fixture.json" "$REPLAY_CASE"
    service_state="$(systemctl is-active factory.service || true)"
    case "$service_state" in active|inactive|failed) ;; *) echo "production service state unavailable" >&2; exit 2;; esac
    old_bundle="$(readlink "$sandbox/current")"
    [[ "$old_bundle" =~ ^assets-[a-f0-9]{64}$ ]] || exit 2
    had_hold=false
    [[ -e "$production/disabled" || -L "$production/disabled" ]] && had_hold=true
    # Sync original state before any hold, stop or bundle mutation. Keep it until recovery completes.
    replay_step journal "$recovery" "$old_bundle" "$service_state" "$had_hold" "$issue" "$lane" "$production" "$sandbox" "$out" "$pr" "$n" "$trusted" "$bootstrap"
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
    replay_step preflight "$lane/preflight" "$sandbox"
    production_free
    [[ "$(main_pin)" == "$REPLAY_MAIN_SHA" ]] || { echo "main pin moved" >&2; exit 2; }
    replay_step prepare "$budget" "$lane/state" "$record" "$expected" "$trusted" "$bootstrap" "$issue"
    chmod 700 "$lane/state"
    serve_umask="$(systemctl show factory.service --property=UMask --value 2>/dev/null)" || serve_umask=0022
    # Open the log under the driver's private umask before matching production in the child.
    (
      umask "${serve_umask:-0022}"
      cd "$lane/ws" && exec node server/cli.ts serve --repo "$repo" --state-dir "$lane/state" --issue "$issue" --verification-token-cap 540000 9>&9
    ) >/dev/null 2>>"$out/serve.log" </dev/null &
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
