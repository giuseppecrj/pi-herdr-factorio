#!/bin/bash
# F05 exp 6 (lanes 9, 10): scope limits, OOM containment, named-scope stop, survival of launcher death,
# and an NNP / no-login-session launcher context. No model calls (gateway runs; no prompt is sent).
source ./common.sh
echo "# exp6 at $(date -Is) on $(hostname)"
cg() { systemctl --user show -p ControlGroup --value "$1"; }
cgpath() { echo /sys/fs/cgroup$(cg "$1"); }
ms_since() { python3 -c "import time;print(round((time.time()-$1)*1000))"; }

echo "## launcher context: cgroup=$(cat /proc/self/cgroup) sessions=$(loginctl list-sessions --no-legend 2>&1 | wc -l) XDG_SESSION_ID=${XDG_SESSION_ID:-<unset>} DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-<unset>}"
echo "## user manager: $(systemctl --user is-system-running) delegated controllers: $(cat /sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/cgroup.subtree_control 2>&1)"

start_gateway exp6
WS=$D/ws-exp6; rm -rf $WS; mkdir -p $WS
sandbox_args $WS $D/agent-bare ro

echo; echo "## 6a: two concurrent scopes, MemoryMax=512M TasksMax=64; A allocates 1 GiB, B holds 100 MiB and forks 100 sleeps"
cat > $WS/alloc.py <<'PY'
import sys, time
chunks = []
for i in range(16):
    chunks.append(bytearray(64 << 20))     # 64 MiB, zero-filled -> touched
    print(f"allocated {(i+1)*64} MiB", flush=True)
    time.sleep(0.05)
print("ALLOC-SURVIVED", flush=True)
PY
cat > $WS/hold.sh <<'SH'
python3 -c 'import time; b=bytearray(100<<20); print("B holds 100 MiB", flush=True); time.sleep(8); print("B-ALIVE-AFTER-A", flush=True)' &
for i in $(seq 1 100); do sleep 6 2>/dev/null & done 2>/work/fork.err
wait
echo "B fork errors logged by bash: $(grep -c 'fork' /work/fork.err)"
SH
systemd-run --user --scope --quiet --unit=f05-proto-exp6-b -p MemoryMax=512M -p TasksMax=64 -- "${BW[@]}" /bin/bash /work/hold.sh > $WS/b.out 2>&1 &
BPID=$!
sleep 1.5
echo "B scope: $(systemctl --user is-active f05-proto-exp6-b.scope) memory.max=$(cat $(cgpath f05-proto-exp6-b.scope)/memory.max) pids.max=$(cat $(cgpath f05-proto-exp6-b.scope)/pids.max) pids.current=$(cat $(cgpath f05-proto-exp6-b.scope)/pids.current)"
systemd-run --user --scope --quiet --unit=f05-proto-exp6-a -p MemoryMax=512M -p TasksMax=64 -- "${BW[@]}" /usr/bin/python3 /work/alloc.py > $WS/a.out 2>&1
echo "A exit=$? (OOM killer SIGKILLs python; systemd then stops the failed scope, so the launcher sees bwrap's SIGTERM)"; tail -2 $WS/a.out
echo "A scope after: $(systemctl --user is-active f05-proto-exp6-a.scope 2>&1)"
journalctl --user -u f05-proto-exp6-a.scope --no-pager -o cat 2>/dev/null | grep -iE 'oom|memory|kill' | tail -3
dmesg 2>/dev/null | grep -i 'oom' | tail -2 || true
echo "B scope while A died: $(systemctl --user is-active f05-proto-exp6-b.scope) memory.events: $(tr '\n' ' ' < $(cgpath f05-proto-exp6-b.scope)/memory.events)"
echo "B pids.events (fork attempts refused at TasksMax): $(tr '\n' ' ' < $(cgpath f05-proto-exp6-b.scope)/pids.events) pids.peak=$(cat $(cgpath f05-proto-exp6-b.scope)/pids.peak 2>/dev/null)"
wait $BPID; echo "B exit=$?"; cat $WS/b.out

echo; echo "## 6b: named scope stop kills Pi, Herdr and pane children (TimeoutStopSec=5)"
cat > $WS/stop_inside.sh <<'SH'
socat TCP-LISTEN:18080,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/gw.sock </dev/null >/dev/null 2>&1 &
mkdir -p "$XDG_CONFIG_HOME/herdr"
printf '[terminal]\ndefault_shell = "/bin/bash"\nshell_mode = "non_login"\n' > "$XDG_CONFIG_HOME/herdr/config.toml"
herdr --session s6 server > /work/h6.log 2>&1 &
SOCK=$XDG_CONFIG_HOME/herdr/sessions/s6/herdr.sock
for _ in $(seq 1 200); do python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.connect('$SOCK')" 2>/dev/null && break; sleep 0.1; done
herdr --session s6 workspace create --cwd /work --label s6 --no-focus > /work/ws6.json
PANE=$(python3 -c 'import json;print(json.load(open("/work/ws6.json"))["result"]["root_pane"]["pane_id"])')
herdr --session s6 pane run "$PANE" "sleep 1000 | pi --mode rpc --no-session --no-mcp --no-approve --no-context-files --no-skills --tools read --model openai/gpt-6.1-sol --thinking low" > /dev/null
herdr --session s6 pane split "$PANE" --direction right --no-focus > /work/split.json 2>&1
P2=$(python3 -c 'import json;print(json.load(open("/work/split.json"))["result"]["pane"]["pane_id"])' 2>/dev/null)
[ -n "$P2" ] && herdr --session s6 pane run "$P2" "bash -c 'trap \"\" TERM; sleep 1000'" > /dev/null
echo READY > /work/ready
sleep 1000
SH
rm -f $WS/ready
systemd-run --user --scope --quiet --unit=f05-proto-exp6-stop -p MemoryMax=512M -p TasksMax=256 -p TimeoutStopSec=5 -- \
  "${BW[@]}" /bin/bash /work/stop_inside.sh > $WS/stop.out 2>&1 &
SPID=$!
for _ in $(seq 1 150); do [ -f $WS/ready ] && break; sleep 0.2; done
sleep 4   # let pi finish starting inside its pane
CGP=$(cgpath f05-proto-exp6-stop.scope)
echo "scope cgroup: $CGP; tasks: $(wc -l < $CGP/cgroup.procs)"
echo "processes in scope before stop:"; for p in $(cat $CGP/cgroup.procs); do echo "  $p $(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | cut -c1-120)"; done
HAS_PI=$(for p in $(cat $CGP/cgroup.procs); do tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null; echo; done | grep -cE '^pi( |$)|pi-coding-agent')   # Pi sets its process title to "pi"
HAS_HERDR=$(for p in $(cat $CGP/cgroup.procs); do tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null; echo; done | grep -c 'herdr --session s6 server')
echo "pi processes=$HAS_PI herdr servers=$HAS_HERDR (a TERM-ignoring pane child is included on purpose)"
PIDS=$(cat $CGP/cgroup.procs | tr '\n' ' ')
t0=$(now)
systemctl --user stop f05-proto-exp6-stop.scope
echo "systemctl --user stop returned after $(ms_since $t0) ms"
alive=0; for p in $PIDS; do kill -0 $p 2>/dev/null && alive=$((alive+1)); done
echo "scope processes still alive after stop: $alive of $(echo $PIDS | wc -w); scope state: $(systemctl --user is-active f05-proto-exp6-stop.scope 2>&1); cgroup dir exists: $([ -d $CGP ] && echo yes || echo no)"
wait $SPID 2>/dev/null; echo "launcher saw sandbox exit=$?"

echo; echo "## 6c: scope survives the death of its launcher; found and stopped by name"
for variant in no-die-with-parent die-with-parent; do
  BWV=()
  for a in "${BW[@]}"; do
    [ $variant = no-die-with-parent ] && [ "$a" = --die-with-parent ] && continue
    BWV+=("$a")
  done
  # the launcher stands in for the controller: it starts the scope, then is SIGKILLed
  setsid bash -c 'systemd-run --user --scope --quiet --unit=f05-proto-exp6-surv-'$variant' -p MemoryMax=512M -p TasksMax=64 -- "$@" /bin/sleep 600 & echo $$ > '$WS'/launcher.pid; wait' _ "${BWV[@]}" > /dev/null 2>&1 &
  sleep 1.5
  L=$(cat $WS/launcher.pid)
  echo "[$variant] launcher pid=$L scope=$(systemctl --user is-active f05-proto-exp6-surv-$variant.scope) procs=$(cat $(cgpath f05-proto-exp6-surv-$variant.scope)/cgroup.procs 2>/dev/null | wc -l)"
  kill -9 $L; sleep 1.5
  echo "[$variant] after SIGKILL of launcher: launcher alive=$(kill -0 $L 2>/dev/null && echo yes || echo no) scope=$(systemctl --user is-active f05-proto-exp6-surv-$variant.scope 2>&1)"
  echo "[$variant] found by name: $(systemctl --user list-units --all --no-legend 'f05-proto-exp6-surv-*' | awk '{print $1, $3, $4}' | tr '\n' ';')"
  t0=$(now); systemctl --user stop f05-proto-exp6-surv-$variant.scope 2>/dev/null
  echo "[$variant] stop by name: $(ms_since $t0) ms -> $(systemctl --user is-active f05-proto-exp6-surv-$variant.scope 2>&1)"
done

echo; echo "## 6d: launcher mimicking factory.service: env -i, NNP, XDG_RUNTIME_DIR set, no DBUS/session vars"
NNPCTX=(env -i PATH=/usr/bin:/bin XDG_RUNTIME_DIR=/run/user/1000 setpriv --no-new-privs --)
"${NNPCTX[@]}" bash -c 'echo "launcher NoNewPrivs=$(grep NoNewPrivs /proc/self/status | cut -f2) cgroup=$(cat /proc/self/cgroup) env=$(env | cut -d= -f1 | tr "\n" " ")"'
t0=$(now)
"${NNPCTX[@]}" systemd-run --user --scope --quiet --unit=f05-proto-exp6-nnp -p MemoryMax=512M -p TasksMax=64 -- \
  "${BW[@]}" /bin/bash -c 'echo "in scope: NoNewPrivs=$(grep NoNewPrivs /proc/self/status | cut -f2) cgroup=$(cat /proc/self/cgroup) memory.max(seen from host below)"; sleep 2' &
NP=$!; sleep 1
echo "nnp scope: $(systemctl --user is-active f05-proto-exp6-nnp.scope) memory.max=$(cat $(cgpath f05-proto-exp6-nnp.scope)/memory.max 2>&1) pids.max=$(cat $(cgpath f05-proto-exp6-nnp.scope)/pids.max 2>&1)"
wait $NP; echo "nnp scope run exit=$? total $(ms_since $t0) ms"
echo "-- same launcher WITHOUT XDG_RUNTIME_DIR:"
env -i PATH=/usr/bin:/bin setpriv --no-new-privs -- systemd-run --user --scope --quiet --unit=f05-proto-exp6-noxdg -- /bin/true 2>&1 | head -2
echo "exit=${PIPESTATUS[0]}"
echo "-- NNP launcher can stop a scope by name (controller-side reconcile):"
systemd-run --user --scope --quiet --unit=f05-proto-exp6-nnpstop -- /bin/sleep 300 &
NSPID=$!
sleep 1
"${NNPCTX[@]}" systemctl --user stop f05-proto-exp6-nnpstop.scope; echo "nnp stop exit=$? state=$(systemctl --user is-active f05-proto-exp6-nnpstop.scope 2>&1)"
wait $NSPID 2>/dev/null   # (attempt 1 used a bare `wait`, which also waited on the gateway and hung)
systemctl --user reset-failed 'f05-proto-exp6-*' 2>/dev/null

stop_gateway
echo "## gateway log (must be empty: no model calls in exp6)"; wc -l < $GWD/gw.log
leftovers
