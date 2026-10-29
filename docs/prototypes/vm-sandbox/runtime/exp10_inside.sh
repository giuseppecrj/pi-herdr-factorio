#!/bin/bash
# F05 exp 10: runs INSIDE bwrap. Mount/visibility denial and name resolution.
set -u
OK=0; BAD=0
absent() { # path: PASS if it does not exist or cannot be read
  local p=$1 why
  if [ ! -e "$p" ] && [ ! -L "$p" ]; then why="absent"
  elif ! (cat "$p" >/dev/null 2>&1 || ls "$p" >/dev/null 2>&1); then why="present but unreadable"
  else BAD=$((BAD+1)); echo "FAIL $p is visible: $(ls -ld "$p" 2>&1)"; return; fi
  OK=$((OK+1)); echo "PASS $p: $why"
}
echo "## identity: uid=$(id -u) gid=$(id -g) groups=$(id -G) user=$(id -un 2>&1)"
echo "## mounts (mountinfo targets)"; awk '{print $5, $4}' /proc/self/mountinfo | sort | tr '\n' ';'; echo
echo "## host paths"
for p in /home /home/exedev /home/exedev/.pi /home/exedev/.pi/agent/models.json /home/exedev/.config/gh \
         /home/exedev/.ssh /home/exedev/.local/share/mise /home/exedev/f05-proto2 /home/exedev/factory-state \
         /home/exedev/factory-workspaces /home/exedev/f05-proto2/ws-exp4-npm /home/exedev/f05-proto2/agent-herdr \
         /var/run/docker.sock /run/docker.sock /var/run /run/user/1000 /run/user/1000/bus /run/systemd \
         /tmp/ssh-agent /root /etc/shadow /etc/sudoers /etc/passwd- /var/lib /var/log; do absent $p; done
echo "## SSH agent: env SSH_AUTH_SOCK=${SSH_AUTH_SOCK:-<unset>}; sockets in /tmp: $(find /tmp -type s 2>/dev/null | tr '\n' ' ')"
[ -z "${SSH_AUTH_SOCK:-}" ] && { OK=$((OK+1)); echo "PASS SSH_AUTH_SOCK unset in sandbox env"; }
echo "## every unix socket visible in the sandbox: $(find / -xdev -type s 2>/dev/null | tr '\n' ' ') (plus /run/gw.sock bind: $(ls -l /run/gw.sock | cut -c1-10))"
echo "## environment (names only): $(env | cut -d= -f1 | sort | tr '\n' ' ')"
echo "## pid namespace: visible pids=$(ls -d /proc/[0-9]* | wc -l); /proc/1 cmdline=$(tr '\0' ' ' < /proc/1/cmdline)"
# /proc/1 inside the pid namespace is bwrap itself. Its environ is whatever env bwrap was started with
# (--clearenv only cleans the child). Print variable NAMES only, never values.
P1ENV=$(tr '\0' '\n' < /proc/1/environ 2>/dev/null | cut -d= -f1 | sort | tr '\n' ' ')
echo "## /proc/1/environ readable=$([ -r /proc/1/environ ] && echo yes || echo no) variable names: [$P1ENV]"
EXTRA=$(echo "$P1ENV" | tr ' ' '\n' | grep -vxE 'PATH|' | tr '\n' ' ')
if [ -n "$EXTRA" ]; then BAD=$((BAD+1)); echo "FAIL /proc/1/environ (bwrap's own env) exposes launcher variables: $EXTRA"
else OK=$((OK+1)); echo "PASS /proc/1/environ holds only PATH (bwrap was started under env -i)"; fi
echo "## host pid 1 not visible: /proc/1 is $(tr '\0' ' ' < /proc/1/cmdline | cut -d' ' -f1)"
pgrep -a systemd >/dev/null && { BAD=$((BAD+1)); echo "FAIL host systemd visible"; } || { OK=$((OK+1)); echo "PASS no host processes (systemd, sshd, gateway) visible: $(ps -eo comm= | sort -u | tr '\n' ' ')"; }
echo "## /proc/sys/kernel/hostname=$(cat /proc/sys/kernel/hostname)"
echo "## /etc/hosts:"; cat /etc/hosts; echo "## /etc/resolv.conf:"; cat /etc/resolv.conf
for n in api.github.com github.com github.int.exe.xyz llm.int.exe.xyz registry.npmjs.org pi-factorio pi-factorio.exe.xyz metadata.google.internal; do
  out=$(getent ahosts "$n" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then BAD=$((BAD+1)); echo "FAIL $n resolves: $out" | head -2
  else OK=$((OK+1)); echo "PASS getent ahosts $n: no answer (rc=$rc)"; fi
done
python3 - <<'PY'
import socket
for n in ("api.github.com", "llm.int.exe.xyz"):
    try:
        print("FAIL python resolved", n, socket.getaddrinfo(n, 443))
    except OSError as e:
        print("PASS python getaddrinfo", n, "->", e)
PY
echo "## localhost resolves only to loopback: $(getent ahosts localhost | awk '{print $1}' | sort -u | tr '\n' ' ')"
echo "## inside summary: pass=$OK fail=$BAD"
