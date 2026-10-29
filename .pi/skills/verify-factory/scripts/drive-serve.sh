#!/usr/bin/env bash
# Starts or stops one scoped serve on the lane. start records the PID in
# <lane>/serve.pid and waits for event=controller_ready. stop sends SIGTERM
# to that PID only, waits for it to exit and checks the lock is gone.
# Usage: vm.sh drive-serve.sh <pr-id> <worker-n> start <issue>...
#        vm.sh drive-serve.sh <pr-id> <worker-n> stop
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
export GH_HOST=github.int.exe.xyz
pr="$1"; n="$2"; mode="${3:-}"; shift 3 || true
require_lane_ids "$pr" "$n" || exit 2
repo=giuseppecrj/pi-herdr-factorio
lane="/home/exedev/factory-verification/$pr-w$n"
out="/tmp/swarm-$pr/worker-$n"
mkdir -p "$out"
pidfile="$lane/serve.pid"
log="$out/serve.log"
case "$mode" in
  start)
    [ "$#" -ge 1 ] || { echo "name at least one issue: lanes never serve the whole repository" >&2; exit 2; }
    for issue in "$@"; do
      case "$issue" in ""|0*|*[!0-9]*) printf 'refusing issue: %q\n' "$issue" >&2; exit 2;; esac
    done
    [ ! -s "$pidfile" ] || { echo "a serve started by this lane is recorded in $pidfile; stop it first" >&2; exit 2; }
    chmod 700 "$lane/state"
    args=()
    for issue in "$@"; do args+=(--issue "$issue"); done
    (cd "$lane/ws" && exec setsid node server/cli.ts serve --repo "$repo" --state-dir "$lane/state" "${args[@]}" >/dev/null 2>>"$log" </dev/null) &
    pid=$!
    echo "$pid" > "$pidfile"
    for _ in $(seq 1 60); do
      grep -q "event=controller_ready pid=$pid " "$log" 2>/dev/null && break
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if grep -q "event=controller_ready pid=$pid " "$log"; then
      echo "serve=ready pid=$pid log=$log"
      grep "pid=$pid" "$log" | tail -3
    else
      echo "serve=not_ready pid=$pid log=$log"
      tail -5 "$log"
      kill -0 "$pid" 2>/dev/null || rm -f "$pidfile"
      exit 1
    fi
    ;;
  stop)
    [ -s "$pidfile" ] || { echo "no serve recorded for this lane" >&2; exit 2; }
    pid="$(cat "$pidfile")"
    case "$pid" in ""|*[!0-9]*) echo "bad pid file" >&2; exit 2;; esac
    t0=$(date +%s%N)
    kill -TERM "$pid" 2>/dev/null || echo "pid $pid was not running"
    for _ in $(seq 1 120); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    if kill -0 "$pid" 2>/dev/null; then echo "serve=still_running pid=$pid"; exit 1; fi
    rm -f "$pidfile"
    echo "serve=stopped pid=$pid ms=$(( ($(date +%s%N) - t0) / 1000000 )) lock=$([ -e "$lane/state/controller.lock" ] && echo present || echo absent)"
    tail -3 "$log"
    ;;
  *)
    echo "usage: drive-serve.sh <pr-id> <worker-n> start <issue>... | stop" >&2
    exit 2
    ;;
esac
