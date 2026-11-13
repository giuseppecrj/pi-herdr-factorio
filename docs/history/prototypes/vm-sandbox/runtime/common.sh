# F05 runtime prototype: shared helpers. Sourced by run_exp*.sh on pi-factorio.
set -u
D=/home/exedev/f05-proto2
NODE_DIR=/home/exedev/.local/share/mise/installs/node/26.12.1
HERDR=/home/exedev/.local/bin/herdr
PISA_DIR=/home/exedev/.local/pi          # standalone Pi distribution (ELF + assets)
P=18080                                  # in-sandbox forwarder port
export XDG_RUNTIME_DIR=/run/user/1000
cd $D

now() { python3 -c 'import time;print(f"{time.time():.3f}")'; }

# start_gateway <name> [gateway args...] -> sets GWD, GWPID
start_gateway() {
  local name=$1; shift
  GWD=$D/gw-$name
  rm -rf "$GWD"; mkdir -p "$GWD"; chmod 700 "$GWD"; : > "$GWD/gw.log"
  python3 $D/gateway.py --socket "$GWD/gw.sock" --log "$GWD/gw.log" \
    --client-host 127.0.0.1:$P --client-host localhost:$P "$@" 2> "$GWD/gateway.err" &
  GWPID=$!
  for _ in $(seq 1 50); do grep -q listening "$GWD/gateway.err" 2>/dev/null && break; sleep 0.1; done
  echo "gateway[$name] pid=$GWPID socket=$GWD/gw.sock args: $*"
}
stop_gateway() { kill "$GWPID" 2>/dev/null; wait "$GWPID" 2>/dev/null; true; }

# sandbox_args <workspace-host-dir> <agent-host-dir> <agent-mode ro|rw> -> sets BW array
# The agent dir is bound at /opt/agent (ro) or is inside the workspace (rw: /work/agent).
sandbox_args() {
  local ws=$1 agent=$2 mode=$3
  # bwrap itself becomes pid 1 in the sandbox and its /proc/1/environ is readable from inside;
  # --clearenv only cleans the child. So bwrap is started under env -i (exp10 shows both).
  local envp=(env -i PATH=/usr/bin:/bin)
  [ "${BW_RAW_ENV:-0}" = 1 ] && envp=()
  BW=("${envp[@]}" bwrap --unshare-all --die-with-parent --new-session
    --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/sbin /sbin
    --symlink usr/lib /lib --symlink usr/lib64 /lib64
    --proc /proc --dev /dev --tmpfs /tmp --tmpfs /run --dir /tmp/home --dir /tmp/run
    --ro-bind $D/etc/passwd /etc/passwd --ro-bind $D/etc/group /etc/group
    --ro-bind $D/etc/hosts /etc/hosts --ro-bind $D/etc/resolv.conf /etc/resolv.conf
    --ro-bind /etc/nsswitch.conf /etc/nsswitch.conf --ro-bind /etc/alternatives /etc/alternatives
    --ro-bind /etc/ssl /etc/ssl --ro-bind /etc/ld.so.cache /etc/ld.so.cache
    --ro-bind $NODE_DIR /opt/node --ro-bind $D/rt /opt/pi --ro-bind $HERDR /opt/bin/herdr
    --ro-bind $PISA_DIR /opt/pi-standalone
    --ro-bind $D/scripts /opt/scripts
    --bind "$GWD/gw.sock" /run/gw.sock
    --bind "$ws" /work --chdir /work
    --clearenv
    --setenv PATH /opt/pi/node_modules/.bin:/opt/node/bin:/opt/bin:/usr/bin:/usr/sbin
    --setenv HOME /tmp/home --setenv USER sandbox --setenv SHELL /bin/bash
    --setenv TERM xterm-256color --setenv LANG C.UTF-8
    --setenv XDG_CONFIG_HOME /tmp/home/.config --setenv XDG_CACHE_HOME /tmp/home/.cache
    --setenv XDG_STATE_HOME /tmp/home/.local/state --setenv XDG_DATA_HOME /tmp/home/.local/share
    --setenv XDG_RUNTIME_DIR /tmp/run
    --setenv PI_SKIP_VERSION_CHECK 1 --setenv PI_TELEMETRY 0 --setenv PI_OFFLINE 1)
  if [ "$mode" = ro ]; then
    BW+=(--ro-bind "$agent" /opt/agent --setenv PI_CODING_AGENT_DIR /opt/agent)
  else
    BW+=(--setenv PI_CODING_AGENT_DIR /work/agent)
  fi
}

# scope_cmd <unit> -> sets SC array (prefix that runs a command in a named user scope)
scope_cmd() {
  # shellcheck disable=SC2034  # SC is consumed by the run_exp*.sh scripts that source this file
  SC=(systemd-run --user --scope --quiet --unit="$1" -p MemoryMax=512M -p TasksMax=256 -p TimeoutStopSec=5)
}

leftovers() {
  echo "## leftovers check"
  pgrep -af 'gateway.py|fakeup.py|socat TCP-LISTEN:18080|bwrap|herdr|pi --mode' | grep -v pgrep || echo "no matching processes"
  systemctl --user list-units --all 'f05-proto*' --no-legend || true
}
