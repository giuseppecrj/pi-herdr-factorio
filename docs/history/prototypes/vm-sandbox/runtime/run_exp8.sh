#!/bin/bash
# F05 exp 8: refusal surface. Pi (npm 1.4.0) in the sandbox, gateway routes /openai/v1/* to a FAKE
# upstream on host 127.0.0.1:18998 (no real model call). One fresh Pi per scenario.
source ./common.sh
echo "# exp8 at $(date -Is) on $(hostname)"
SCEN=$D/exp8-scenario; : > $SCEN
python3 $D/fakeup.py --port 18998 --scenario-file $SCEN 2> $D/fakeup.err &
FPID=$!
sleep 0.5
start_gateway exp8 --fake-openai-port 18998
WS=$D/ws-exp8; rm -rf $WS; mkdir -p $WS; cp -a $D/agent-bare $WS/agent   # Pi needs a writable agent dir (exp4)
PIFLAGS=(--mode rpc --no-session --no-mcp --no-approve --no-context-files --no-skills --tools subagent
         --model openai/gpt-6.1-sol --thinking low)
sandbox_args $WS $D/agent-bare rw
for s in incomplete_content_filter failed_content_filter refusal_part http400_content_policy http500; do
  echo "$s" > $SCEN
  n0=$(wc -l < $GWD/gw.log)
  echo "## scenario $s"
  U=f05-proto-exp8-${s//_/-}
  scope_cmd $U
  python3 $D/rpcdrive.py --out $D/exp8-$s.events.jsonl --stderr $D/exp8-$s.stderr --unit $U \
    --prompt 'hi' --timeout 60 -- "${SC[@]}" -- "${BW[@]}" \
    /opt/scripts/sbx-entry.sh pi "${PIFLAGS[@]}" > $D/exp8-$s.summary.json
  python3 - $D/exp8-$s.summary.json <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
print("  event order:", " ".join(s["seq"]))
for a in s["assistant"]:
    print("  assistant message_end:", json.dumps({k: a[k] for k in ("stopReason", "rawStopReason", "errorMessage", "content", "usage")}))
print("  auto_retry events:", [(r["t"], r["payload"].get("type"), r["payload"].get("attempt"), r["payload"].get("delayMs"), (r["payload"].get("errorMessage") or "")[:120]) for r in s["retries"]])
print("  agent_settled:", [x["payload"] for x in s["settled"]], "notes:", s["notes"])
PY
  echo "  upstream (fake) requests for this scenario: $(( $(wc -l < $GWD/gw.log) - n0 ))"
done
stop_gateway
kill $FPID; wait $FPID 2>/dev/null
echo "## gateway log summary"; python3 $D/gwsummary.py $GWD/gw.log
cp $GWD/gw.log $D/exp8-gw.jsonl
leftovers
