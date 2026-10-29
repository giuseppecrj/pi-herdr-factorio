#!/bin/bash
# F05 exp 5: runs INSIDE bwrap (inside a user scope). Headless herdr server with PTYs from bwrap --dev,
# an RPC parent in a herdr pane (exp5_parent.py), one bare subagent child. Model traffic only via
# the forwarder 127.0.0.1:18080 -> /run/gw.sock.
set -u
S=f05
t0=$(date +%s.%N)
el() { python3 -c "import sys;print(round($(date +%s.%N)-$t0,2))"; }
echo "## sandbox: uid=$(id -u) ifaces=$(ip -br addr | cut -d' ' -f1 | tr '\n' ' ') routes=[$(ip route | tr '\n' ';')]"
echo "## /dev/pts: $(ls /dev/pts | tr '\n' ' ') ptmx=$(ls -l /dev/ptmx | cut -c1-10)"
socat TCP-LISTEN:18080,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/gw.sock </dev/null >/dev/null 2>/tmp/socat.err &
for _ in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/18080) 2>/dev/null && break; sleep 0.1; done
mkdir -p "$XDG_CONFIG_HOME/herdr" /work/proj
printf '[terminal]\ndefault_shell = "/bin/bash"\nshell_mode = "non_login"\n' > "$XDG_CONFIG_HOME/herdr/config.toml"
echo "versions: pi=$(pi --version) herdr=$(herdr --version) node=$(node --version)"
herdr --session $S server > /work/herdr-server.log 2>&1 &
HPID=$!
SOCK=$XDG_CONFIG_HOME/herdr/sessions/$S/herdr.sock
for _ in $(seq 1 200); do python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.connect('$SOCK')" 2>/dev/null && break; sleep 0.1; done
echo "herdr server ready after $(el)s (pid $HPID, socket $SOCK)"
herdr --session $S workspace create --cwd /work/proj --label exp5 --no-focus > /work/workspace.json 2>/work/workspace.err
PANE=$(python3 -c 'import json;print(json.load(open("/work/workspace.json"))["result"]["root_pane"]["pane_id"])')
echo "workspace ready after $(el)s pane=$PANE"
herdr --session $S pane run "$PANE" "python3 /opt/scripts/exp5_parent.py" > /work/run.json 2>/work/run.err
herdr --session $S pane wait-output "$PANE" --match exp5-parent-finished --timeout 300000 > /work/wait.json 2>/work/wait.err
echo "parent finished after $(el)s (wait rc=$?)"
echo "## herdr pane list before stop"; herdr --session $S pane list 2>&1 | head -c 1500; echo
echo "## processes in sandbox before stop"; ps -eo pid,ppid,etimes,comm,args --sort=pid | cut -c1-160
ts=$(date +%s.%N)
timeout 10s herdr --session $S server stop > /dev/null 2>&1
kill $HPID 2>/dev/null; wait $HPID 2>/dev/null
echo "herdr stop took $(python3 -c "print(round($(date +%s.%N)-$ts,2))")s"
echo "## processes in sandbox after herdr stop"; ps -eo pid,ppid,comm --sort=pid
