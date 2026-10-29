#!/usr/bin/bash
# F05 R1 experiment 3b: INSIDE bwrap. One smallest-possible Responses-API call on gpt-6.1-sol through the gateway.
# This is the API Pi's openai provider uses (POST {baseUrl}/responses).
set -u
P=18080; B=http://127.0.0.1:$P
socat -lp fwd TCP-LISTEN:$P,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/gw.sock &
FWD=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do (exec 3<>/dev/tcp/127.0.0.1/$P) 2>/dev/null && break; sleep 0.2; done
echo "## sandbox: interfaces=$(ip -br addr | cut -d' ' -f1 | tr '\n' ' ') routes=[$(ip route | tr '\n' ';')]"
REQ='{"model":"gpt-6.1-sol","input":[{"role":"user","content":"Reply with exactly: OK"}],"max_output_tokens":16,"store":false,"stream":true}'
echo "request: POST /openai/v1/responses $REQ"
RESP=$(curl -sS -m 120 -w '\n%{http_code}' -H 'content-type: application/json' -d "$REQ" $B/openai/v1/responses)
CODE=$(echo "$RESP" | tail -1)
echo "http=$CODE"
echo "$RESP" | sed '$d' | python3 -c '
import json,sys
raw=sys.stdin.read()
events=[]; final=None
for line in raw.splitlines():
    if line.startswith("data:"):
        d=line[5:].strip()
        if d=="[DONE]": continue
        try: j=json.loads(d)
        except Exception: continue
        events.append(j.get("type"))
        if j.get("type") in ("response.completed","response.incomplete","response.failed"): final=j.get("response")
print("sse events:", len(events), "types:", sorted(set(events)))
if final:
    texts=[c.get("text") for o in final.get("output",[]) if o.get("type")=="message" for c in o.get("content",[]) if c.get("type")=="output_text"]
    print("model:", final.get("model"), "| status:", final.get("status"), "| incomplete:", final.get("incomplete_details"),
          "| output types:", [o.get("type") for o in final.get("output",[])], "| text:", texts, "| usage:", json.dumps(final.get("usage")))
else:
    print("no final event; raw head:", raw[:400])'
[ "$CODE" = 200 ] && echo "PASS model path end to end" || echo "FAIL model path end to end"
kill $FWD 2>/dev/null
