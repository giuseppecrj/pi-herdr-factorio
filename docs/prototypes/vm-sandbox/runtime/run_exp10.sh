#!/bin/bash
# F05 exp 10 (lane 6): mount denial, using the same sandbox_args as every other experiment.
source ./common.sh
echo "# exp10 at $(date -Is) on $(hostname)"
echo "## host-side controls (outside the sandbox): these exist on the host"
ls -ld /home/exedev /home/exedev/.pi /var/run/docker.sock /run/user/1000/bus 2>&1
start_gateway exp10
WS=$D/ws-exp10; rm -rf $WS; mkdir -p $WS
sandbox_args $WS $D/agent-bare ro
scope_cmd f05-proto-exp10
"${SC[@]}" -- "${BW[@]}" /bin/bash /opt/scripts/exp10_inside.sh
echo "sandbox exit=$?"
stop_gateway
echo "## sandbox bwrap argv (what is bound):"; printf '%s ' "${BW[@]}"; echo
leftovers
