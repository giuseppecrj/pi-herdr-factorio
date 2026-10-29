#!/bin/bash
# F05 exp 4: Pi RPC inside the sandbox. A = npm Pi 1.4.0, B = standalone ~/.local/pi/pi, both with a
# clean PI_CODING_AGENT_DIR, a clean tmpfs HOME, http:// baseUrl to the forwarder.
# Attempt 1 bound the agent dir read-only: Pi rejected the prompt (EROFS on auth.json; see
# exp4-pi-rpc.attempt1-ro-agent-dir.log). Each variant now gets a fresh writable copy at /work/agent.
source ./common.sh
echo "# exp4 at $(date -Is) on $(hostname)"
start_gateway exp4 --gate-file $D/gw-exp4-gate.json --auto-gate-tokens 6000
rm -f $D/gw-exp4-gate.json
PIFLAGS=(--mode rpc --no-session --no-mcp --no-approve --no-context-files --no-skills --tools subagent
         --model openai/gpt-6.1-sol --thinking low)
PROMPT='Reply with exactly: OK'
run_variant() { # name pi-binary
  local name=$1 bin=$2
  rm -rf $D/ws-exp4-$name; mkdir -p $D/ws-exp4-$name
  cp -a $D/agent-bare $D/ws-exp4-$name/agent
  sandbox_args $D/ws-exp4-$name $D/agent-bare rw
  scope_cmd f05-proto-exp4-$name
  echo "## variant $name: $bin ${PIFLAGS[*]}"
  echo "## launch: ${SC[*]} -- bwrap(...) /opt/scripts/sbx-entry.sh $bin ..."
  python3 $D/rpcdrive.py --out $D/exp4-$name.events.jsonl --stderr $D/exp4-$name.stderr \
    --unit f05-proto-exp4-$name --prompt "$PROMPT" --stats --timeout 120 -- \
    "${SC[@]}" -- "${BW[@]}" /opt/scripts/sbx-entry.sh "$bin" "${PIFLAGS[@]}"
  echo "## $name stderr (Pi diagnostics)"; head -c 2000 $D/exp4-$name.stderr; echo
  echo "## $name: files Pi wrote into its agent dir copy:"; (cd $D/ws-exp4-$name/agent && find . -type f -newer models.json -printf '%p %s bytes\n' | head)
}
run_variant npm /opt/pi/node_modules/.bin/pi
run_variant standalone /opt/pi-standalone/pi
stop_gateway
echo "## gateway log summary"; python3 $D/gwsummary.py $GWD/gw.log
cp $GWD/gw.log $D/exp4-gw.jsonl
leftovers
