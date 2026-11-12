#!/usr/bin/env python3
"""F05 exp 5 parent driver. Runs INSIDE a herdr pane inside the sandbox (adapted from
scripts/herdr-probe.sh). Starts `pi --mode rpc` with only the `subagent` tool, asks it to launch one
bare child, and logs EVERY RPC record with a timestamp to /work/events.jsonl. Stops after the parent's
settle that follows the subagent_result (or a 240 s deadline)."""
import json
import os
import selectors
import subprocess
import time
from pathlib import Path
from typing import Any

root = Path("/work")
model = "openai/gpt-6.1-sol"
args = {"name": "exp5-child", "model": model, "thinking": "low", "fork": False, "tools": "read",
        "cwd": "/work/proj", "task": "Reply with exactly herdr-child-ok and nothing else. Do not call tools."}
prompt = ("Call subagent exactly ONCE with these arguments: " + json.dumps(args) +
          ". Do not call any other tool. After the launch acknowledgement end your turn. "
          "The child result arrives automatically; do not poll. After the subagent_result message, "
          "reply exactly: herdr-parent-received")
T0 = time.time()
summary: dict[str, Any] = {"env": {k: os.environ.get(k) for k in ("HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "PI_CODING_AGENT_DIR")}}
proc = None
try:
    with (root / "parent.stderr").open("wb") as err, (root / "events.jsonl").open("w") as log:
        proc = subprocess.Popen(["pi", "--mode", "rpc", "--no-approve", "--no-mcp", "--no-skills",
                                 "--no-context-files", "--tools", "subagent", "--model", model, "--thinking", "low",
                                 "--session-dir", str(root / "parent-sessions")],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err)
        assert proc.stdin is not None and proc.stdout is not None
        pin, pout = proc.stdin, proc.stdout

        def send(rec):
            log.write(json.dumps({"t": round(time.time() - T0, 3), "te": round(time.time(), 3), "dir": "out", "rec": rec}) + "\n")
            pin.write(json.dumps(rec).encode() + b"\n")
            pin.flush()

        send({"id": "p1", "type": "prompt", "message": prompt})
        sel = selectors.DefaultSelector()
        sel.register(pout, selectors.EVENT_READ)
        deadline = time.time() + 240
        buf = b""
        got_result = False
        done = False
        while not done and time.time() < deadline:
            if not sel.select(max(0.0, deadline - time.time())):
                break
            chunk = os.read(pout.fileno(), 65536)
            if not chunk:
                summary["eof"] = True
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                ev = json.loads(line)
                rec = ev
                if ev.get("type") == "message_update":
                    e2 = dict(ev.get("assistantMessageEvent") or {})
                    e2.pop("partial", None)
                    rec = {"type": "message_update", "assistantMessageEvent": e2}
                log.write(json.dumps({"t": round(time.time() - T0, 3), "te": round(time.time(), 3), "dir": "in", "rec": rec}) + "\n")
                log.flush()
                msg = ev.get("message") or {}
                if ev.get("type") == "message_end" and msg.get("customType") == "subagent_result":
                    got_result = True
                if ev.get("type") == "agent_settled" and got_result:
                    done = True
        if done:
            send({"id": "stats", "type": "get_session_stats"})
            t_end = time.time() + 10
            while time.time() < t_end and sel.select(t_end - time.time()):
                chunk = os.read(pout.fileno(), 65536)
                if not chunk:
                    break
                buf += chunk
                if b'"get_session_stats"' in buf:
                    for line in buf.split(b"\n"):
                        if b'"get_session_stats"' in line:
                            summary["parent_stats"] = json.loads(line).get("data")
                    break
        summary["done"] = done
        summary["got_result"] = got_result
except Exception as exc:  # noqa: BLE001 - record the failure for the host-side analysis
    summary["exception"] = f"{type(exc).__name__}: {exc}"[:500]
finally:
    if proc is not None:
        t_close = time.time()
        if proc.stdin:
            proc.stdin.close()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        summary["parent_exit_after_stdin_close_s"] = round(time.time() - t_close, 3)
        summary["parent_exit_code"] = proc.returncode
    (root / "parent-summary.json").write_text(json.dumps(summary, indent=1))
    print("exp5-parent-finished", flush=True)
