#!/usr/bin/env python3
"""Summarize a gateway JSONL log: one line per request plus token totals."""
import json
import sys

with open(sys.argv[1]) as fh:
    recs = [json.loads(line) for line in fh if line.strip()]
tot = 0
for r in recs:
    up = r.get("upstream") or {}
    req = r.get("request") or {}
    resp = r.get("response") or {}
    u = resp.get("usage") or {}
    tot += u.get("total_tokens") or 0 if r.get("route") != "fake" else 0
    print(f"#{r['id']} t={r.get('t')} {r['method']} {r['client_target'][:70]} -> {r.get('decision')} "
          f"route={r.get('route')} status={r.get('status')} "
          f"upstream={(up.get('scheme'), up.get('host_header_sent'), up.get('sni_sent'), up.get('peer')) if up else None}"
          + (f" | req model={req.get('model')} tools={req.get('tools')} input_items={req.get('input_items')} "
             f"instr_chars={req.get('instructions_chars')} reasoning={req.get('reasoning')}" if req else "")
          + (f" | resp terminal={resp.get('terminal')} usage={json.dumps(u) if u else None}" if 'terminal' in resp else "")
          + (f" | resp_head={resp.get('body_head')!r}" if resp.get('body_head') else "")
          + (f" | gate_body={json.dumps(r.get('gate_body'))}" if r.get('decision') == 'gated' else "")
          + (f" | reason={r.get('reason')}" if r.get('reason') else "")
          + (f" | ERROR {r.get('error')}" if r.get('error') else ""))
fw = [r for r in recs if r.get("decision") == "forward"]
print(f"requests={len(recs)} forwarded={len(fw)} gated={sum(1 for r in recs if r.get('decision') == 'gated')} "
      f"denied={sum(1 for r in recs if r.get('decision') == 'deny')} errors={sum(1 for r in recs if 'error' in r)}")
print(f"upstream hosts: {sorted({(r['upstream'].get('host_header_sent'), r['upstream'].get('sni_sent')) for r in fw}, key=str)}")
print(f"REAL_MODEL_TOKENS_TOTAL={tot}")
