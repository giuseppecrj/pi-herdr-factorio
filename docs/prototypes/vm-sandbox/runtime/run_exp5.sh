#!/bin/bash
# F05 exp 5 (lane 7): real Herdr fan-out inside the sandbox; parent + one bare child via the gateway.
source ./common.sh
echo "# exp5 at $(date -Is) on $(hostname)"
# safety cap: 11000 tokens in this stage keeps the whole run under 20k even if one request overshoots
start_gateway exp5 --gate-file $D/gw-exp5-gate.json --auto-gate-tokens 11000 --mark herdr-parent-received
rm -f $D/gw-exp5-gate.json
WS=$D/ws-exp5; rm -rf $WS; mkdir -p $WS
cp -a $D/agent-herdr $WS/agent          # writable copy: child session files live under the agent dir
sandbox_args $WS $D/agent-herdr rw
scope_cmd f05-proto-exp5
t0=$(now)
"${SC[@]}" -- "${BW[@]}" /bin/bash /opt/scripts/exp5_inside.sh
echo "sandbox exit=$? total_seconds=$(python3 -c "print(round($(now)-$t0,1))")"
echo "scope after: $(systemctl --user is-active f05-proto-exp5.scope)"
stop_gateway
cp $GWD/gw.log $D/exp5-gw.jsonl
cp $WS/events.jsonl $D/exp5-parent-events.jsonl 2>/dev/null
echo "## parent summary"; cat $WS/parent-summary.json 2>/dev/null; echo
echo "## parent stderr (head)"; head -c 1500 $WS/parent.stderr 2>/dev/null; echo
echo "## herdr server log (head)"; head -c 1500 $WS/herdr-server.log 2>/dev/null; echo
echo "## gateway log summary"; python3 $D/gwsummary.py $GWD/gw.log
echo "## analysis"
python3 - "$WS" "$GWD/gw.log" <<'PY'
import json, sys, glob, os
ws, gwl = sys.argv[1], sys.argv[2]
ev = [json.loads(l) for l in open(os.path.join(ws, "events.jsonl")) if l.strip()]
gw = [json.loads(l) for l in open(gwl) if l.strip()]
seq = []
for e in ev:
    r = e["rec"]; typ = r.get("type")
    if typ == "response": typ = f"response:{r.get('command')}"
    m = r.get("message") or {}
    if typ in ("message_start", "message_end"):
        typ += f"({m.get('customType') or m.get('role')})"
    if typ in ("tool_execution_start", "tool_execution_end"):
        typ += f"({r.get('toolName')})"
    if seq and seq[-1][1] == typ: seq[-1][2] += 1
    else: seq.append([e["t"], typ, 1])
print("parent event order (t = s since parent start; ×n = repeats):")
for t, typ, n in seq: print(f"  {t:8.3f} {typ}{' ×%d' % n if n > 1 else ''}")
settled = [e for e in ev if e["rec"].get("type") == "agent_settled"]
res = [e for e in ev if e["rec"].get("type") == "message_end" and (e["rec"].get("message") or {}).get("customType") == "subagent_result"]
print("agent_settled:", [(e["t"], e["rec"]) for e in settled])
if res:
    r0 = res[0]
    print("first agent_settled t=", settled[0]["t"] if settled else None, " subagent_result t=", r0["t"],
          " ORDER:", "settled-before-result" if settled and settled[0]["t"] < r0["t"] else "result-first-or-no-settle")
    prev = [e for e in ev if e["dir"] == "in" and e["t"] < r0["t"] and e["rec"].get("type") != "message_start"]
    # silent period: gap between the last parent record before the result and the result itself
    last_before = max((e["t"] for e in ev if e["dir"] == "in" and e["t"] < r0["t"]
                       and not ((e["rec"].get("message") or {}).get("customType") == "subagent_result")), default=None)
    print(f"parent silent period while child ran: {round(r0['t'] - last_before, 3) if last_before is not None else None}s "
          f"(last parent record before result at t={last_before})")
    d = (r0["rec"]["message"] or {}).get("details") or {}
    print("subagent_result details keys:", sorted(d.keys()))
    print("details:", json.dumps({k: d.get(k) for k in ("name", "exitCode", "error", "elapsed", "sessionFile", "model", "usage")})[:800])
    sf = d.get("sessionFile")
    if sf:
        host = sf.replace("/work", ws, 1)
        ents = [json.loads(l) for l in open(host) if l.strip()]
        asst = [x["message"] for x in ents if x.get("type") == "message" and x["message"].get("role") == "assistant"]
        u = [a.get("usage") for a in asst]
        print("child session assistant messages:", len(asst), "provider/model:", [(a.get("provider"), a.get("model")) for a in asst])
        print("child usage per message:", json.dumps(u))
        print("child final text:", [''.join(b.get('text', '') for b in a['content'] if b['type'] == 'text') for a in asst][-1:])
        print("child total tokens (session file):", sum((x or {}).get("totalTokens", 0) for x in u))
# parent usage
pu = [e["rec"]["message"].get("usage") for e in ev if e["rec"].get("type") == "message_end" and (e["rec"].get("message") or {}).get("role") == "assistant"]
print("parent usage per assistant message:", json.dumps(pu))
print("parent total tokens:", sum((x or {}).get("totalTokens", 0) for x in pu))
# gateway: which requests are child vs parent (child has tools [read], parent [subagent])
for g in gw:
    req = g.get("request") or {}
    resp = g.get("response") or {}
    # the parent's prompt contains "herdr-parent-received"; the child's task does not
    who = "parent" if "herdr-parent-received" in (req.get("markers") or []) else "child"
    print(f"  gw #{g['id']} t={g['t']} {g['client_target']} {g['decision']} who={who} tools={req.get('tools')} keys={req.get('keys')} "
          f"usage_total={(resp.get('usage') or {}).get('total_tokens')} upstream_host={(g.get('upstream') or {}).get('host_header_sent')}")
PY
leftovers
