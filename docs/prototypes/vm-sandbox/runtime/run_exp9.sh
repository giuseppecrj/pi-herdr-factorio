#!/bin/bash
# F05 exp 9 (lane 3): npm through the gateway.
source ./common.sh
echo "# exp9 at $(date -Is) on $(hostname)"
start_gateway exp9
WS=$D/ws-exp9; rm -rf $WS; mkdir -p $WS
sandbox_args $WS $D/agent-bare ro
scope_cmd f05-proto-exp9
"${SC[@]}" -- "${BW[@]}" /bin/bash /opt/scripts/exp9_inside.sh
echo "sandbox exit=$?"
stop_gateway
echo "## gateway log summary"; python3 $D/gwsummary.py $GWD/gw.log
cp $GWD/gw.log $D/exp9-gw.jsonl
leftovers
