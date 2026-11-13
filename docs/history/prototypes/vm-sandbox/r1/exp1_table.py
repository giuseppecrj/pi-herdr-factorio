#!/usr/bin/env python3
"""Condense the exp1 JSONL lines into a fingerprint table (run locally on the log)."""
import json
import sys


def fp(r):
    s = r.get("snippet", "") or ""
    hn = r.get("header_names", [])
    if r.get("status") == "ERR":
        return "ERR"
    if "x-github-request-id" in hn:
        return "GITHUB-API"
    if s.startswith('{"object":"list"'):
        return "LLM-models(grok)" if "grok" in s or "xai/" in s else "LLM-models"
    if "configured repository" in s:
        return "GH-INTEGRATION"
    if s.startswith("404 page not found"):
        return "EDGE-404"
    return "OTHER:" + s[:50]


try:
    with open(sys.argv[1]) as fh:
        lines = fh.read().splitlines()
except (IndexError, OSError) as e:
    sys.exit(f"usage: exp1_table.py <log>: {e}")

for line in lines:
    line = line.strip()
    if not line.startswith("{"):
        if line.startswith(("#", "---")):
            print(line)
        continue
    try:
        r = json.loads(line)
    except json.JSONDecodeError:
        print("UNPARSED:", line[:120])
        continue
    extra = r.get("error", "")
    print(f"{r['path']:<18} {r['name']:<70} {str(r.get('status')):<4} trace={r.get('x_trace_id_count', '-')} "
          f"sha={r.get('body_sha256', '-')} => {fp(r)} {extra}")
