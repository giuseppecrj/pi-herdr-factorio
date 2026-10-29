#!/bin/bash
# F05 runtime prototype: final VM cleanup. Records script hashes, stops any f05-proto scopes,
# kills leftover prototype processes, deletes the scratch dir, and proves nothing remains.
export XDG_RUNTIME_DIR=/run/user/1000
D=/home/exedev/f05-proto2
echo "# cleanup at $(date -Is) on $(hostname)"
echo "## sha256 of the scripts the VM ran"
(cd $D && sha256sum *.sh *.py 2>/dev/null)
echo "## stopping any f05-proto units"
for u in $(systemctl --user list-units --all --no-legend 'f05-proto*' | awk '{print $1}'); do
  systemctl --user stop "$u"; echo "stopped $u"
done
pkill -f "$D/gateway.py" 2>/dev/null; pkill -f "$D/fakeup.py" 2>/dev/null
rm -rf "$D"
echo "## after cleanup"
ls -ld "$D" 2>&1
echo "processes matching gateway/fakeup/socat/bwrap/herdr/pi rpc/f05:"
pgrep -af 'gateway.py|fakeup.py|socat TCP-LISTEN:18080|bwrap|herdr|pi --mode|f05-proto' | grep -v pgrep || echo none
echo "user units matching f05:"; systemctl --user list-units --all --no-legend 'f05*'; echo "(end)"
echo "listeners on 18080/18998:"; ss -ltnp 2>/dev/null | grep -E ':18080|:18998' || echo none
echo "~/.pi untouched (mtimes):"; ls -la --time-style=full-iso /home/exedev/.pi/agent/models.json /home/exedev/.pi/agent/settings.json
