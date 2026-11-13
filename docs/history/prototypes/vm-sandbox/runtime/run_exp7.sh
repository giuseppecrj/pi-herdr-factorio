#!/bin/bash
# F05 exp 7 (lane 8): budget gate. A: tiny cap, gate closed mid-stage with a RETRYABLE 429 body,
# Pi auto-retries against the closed gate, runner aborts. B: gate closed before the stage with a
# NON-retryable body ("out of budget") -> no auto-retry at all (0 real tokens).
source ./common.sh
echo "# exp7 at $(date -Is) on $(hostname)"
GATE=$D/gw-exp7-gate.json; rm -f $GATE
start_gateway exp7 --gate-file $GATE --auto-gate-tokens 6000
WS=$D/ws-exp7; rm -rf $WS; mkdir -p $WS; echo "banana split" > $WS/note.txt
cp -a $D/agent-bare $WS/agent   # Pi needs a writable agent dir (exp4)
PIFLAGS=(--mode rpc --no-session --no-mcp --no-approve --no-context-files --no-skills --tools read
         --model openai/gpt-6.1-sol --thinking low)
sandbox_args $WS $D/agent-bare rw
echo "## A: retryable gate body, closed after the first assistant message_end with usage"
scope_cmd f05-proto-exp7-a
python3 $D/rpcdrive.py --mode gate --gate-file $GATE \
  --gate-json '{"status":429,"body":{"error":{"message":"f05 budget gate closed: admission denied","type":"budget_gate","code":"budget_gate_closed"}}}' \
  --retries-before-abort 2 --out $D/exp7-a.events.jsonl --stderr $D/exp7-a.stderr --unit f05-proto-exp7-a \
  --prompt 'Use the read tool to read note.txt, then reply with its first word only.' --timeout 90 -- \
  "${SC[@]}" -- "${BW[@]}" /opt/scripts/sbx-entry.sh pi "${PIFLAGS[@]}"
echo "## A gateway log"; python3 $D/gwsummary.py $GWD/gw.log
cp $GWD/gw.log $D/exp7-a-gw.jsonl
python3 - $D/exp7-a.events.jsonl $GWD/gw.log <<'PY'
import json, sys
ev = [json.loads(l) for l in open(sys.argv[1])]
gw = [json.loads(l) for l in open(sys.argv[2])]
# the gate-close epoch is in the driver summary above (timings.gate_closed_epoch)
fwd = [g for g in gw if g["decision"] == "forward"]
gated = [g for g in gw if g["decision"] == "gated"]
print("forwarded (upstream) requests:", [(g["id"], g["t"]) for g in fwd])
print("gated requests (no upstream):", [(g["id"], g["t"]) for g in gated])
print("any forward AFTER first gated record:", any(f["t"] > gated[0]["t"] for f in fwd) if gated else "n/a")
retry = [(e["t"], e["rec"]) for e in ev if e["rec"].get("type", "").startswith("auto_retry")]
print("auto_retry events:", json.dumps(retry)[:1500])
PY
rm -f $GATE
echo "## B: non-retryable gate body, gate closed before the stage"
echo '{"status":429,"body":{"error":{"message":"f05 budget gate closed: out of budget","type":"budget_gate","code":"budget_gate_closed"}}}' > $GATE
: > $GWD/gw.log
scope_cmd f05-proto-exp7-b
python3 $D/rpcdrive.py --out $D/exp7-b.events.jsonl --stderr $D/exp7-b.stderr --unit f05-proto-exp7-b \
  --prompt 'Reply with exactly: OK' --timeout 60 -- \
  "${SC[@]}" -- "${BW[@]}" /opt/scripts/sbx-entry.sh pi "${PIFLAGS[@]}"
echo "## B gateway log"; python3 $D/gwsummary.py $GWD/gw.log
cp $GWD/gw.log $D/exp7-b-gw.jsonl
rm -f $GATE
stop_gateway
leftovers
