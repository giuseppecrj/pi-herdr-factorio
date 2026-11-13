#!/usr/bin/env python3
"""Host-side Pi RPC driver for the F05 runtime prototype (exp 4, 7, 8).

It plays the runner: it spawns `systemd-run --user --scope -- bwrap ... pi --mode rpc` and
speaks JSONL over the process's stdin/stdout (split on LF only, never readline on text).

Modes:
  simple  get_state -> prompt -> wait agent_settled -> [get_session_stats] -> close stdin.
  gate    like simple, but plays the budget gate: after the first assistant message_end with
          usage (cap = 1 token, i.e. any usage) it writes --gate-file, then waits until Pi has
          started >= --retries-before-abort auto-retries (or 15 s), sends abort, and measures
          abort -> agent_settled -> exit. If the model settles without a second request, it sends
          a follow-up prompt so the next request hits the closed gate.
Every record is logged with t = seconds since spawn (and epoch te). message_update records are
logged without their `partial` snapshot to keep the log small.
"""
import argparse
import contextlib
import json
import os
import queue
import subprocess
import sys
import threading
import time

ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
ap.add_argument("--stderr", required=True)
ap.add_argument("--unit", required=True)
ap.add_argument("--prompt", required=True)
ap.add_argument("--followup", default="Now reply with exactly: done")
ap.add_argument("--mode", choices=["simple", "gate"], default="simple")
ap.add_argument("--gate-file", default="")
ap.add_argument("--gate-json", default="")
ap.add_argument("--retries-before-abort", type=int, default=2)
ap.add_argument("--timeout", type=float, default=120)
ap.add_argument("--stats", action="store_true")
ap.add_argument("cmd", nargs=argparse.REMAINDER)
A = ap.parse_args()
cmd = A.cmd[1:] if A.cmd and A.cmd[0] == "--" else A.cmd

T0 = time.time()
rel = lambda: round(time.time() - T0, 3)  # noqa: E731
Q = queue.Queue()
WFLAGS = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
LOG_FD = os.open(A.out, WFLAGS, 0o644)   # raw fds: closed explicitly at the end of the run
ERR_FD = os.open(A.stderr, WFLAGS, 0o644)


def logrec(direction, rec):
    r = rec
    if direction == "in" and rec.get("type") == "message_update":
        ev = dict(rec.get("assistantMessageEvent") or {})
        ev.pop("partial", None)
        r = {"type": "message_update", "assistantMessageEvent": ev}
    os.write(LOG_FD, (json.dumps({"t": rel(), "te": round(time.time(), 3), "dir": direction, "rec": r}) + "\n").encode())


proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=ERR_FD)
assert proc.stdin is not None and proc.stdout is not None
PIN, POUT = proc.stdin, proc.stdout


def reader():
    buf = b""
    fd = POUT.fileno()
    while True:
        chunk = os.read(fd, 65536)
        if not chunk:
            Q.put(None)
            return
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            line = line.rstrip(b"\r")
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                rec = {"type": "__unparseable__", "raw": line[:300].decode("utf-8", "replace")}
            logrec("in", rec)
            Q.put((rel(), rec))


threading.Thread(target=reader, daemon=True).start()


def send(rec):
    logrec("out", rec)
    PIN.write(json.dumps(rec).encode() + b"\n")
    PIN.flush()


S = {"timings": {}, "seq": [], "settled": [], "assistant": [], "retries": [], "responses": {},
     "eof": False, "notes": []}


def note_seq(typ):
    if S["seq"] and S["seq"][-1][0] == typ:
        S["seq"][-1][1] += 1
    else:
        S["seq"].append([typ, 1])


def handle(t, rec):
    typ = rec.get("type")
    note_seq(typ if typ != "response" else f"response:{rec.get('command')}")
    if typ == "response":
        S["responses"][rec.get("id") or rec.get("command")] = {"t": t, **{k: rec.get(k) for k in ("command", "success", "error", "data")}}
    elif typ == "agent_settled":
        S["settled"].append({"t": t, "payload": rec})
    elif typ in ("auto_retry_start", "auto_retry_end"):
        S["retries"].append({"t": t, "payload": rec})
    elif typ == "message_end" and (rec.get("message") or {}).get("role") == "assistant":
        m = rec["message"]
        S["assistant"].append({"t": t, "stopReason": m.get("stopReason"), "rawStopReason": m.get("rawStopReason"),
                               "errorMessage": m.get("errorMessage"), "usage": m.get("usage"),
                               "provider": m.get("provider"), "model": m.get("model"), "api": m.get("api"),
                               "content": [{"type": b.get("type"), **({"text": (b.get("text") or "")[:200]} if b.get("type") == "text" else {}),
                                            **({"name": b.get("name")} if b.get("type") == "toolCall" else {})}
                                           for b in (m.get("content") or [])],
                               "keys": sorted(m.keys())})


def wait_for(pred, timeout):
    """Consume events until pred(t, rec) is true; return (t, rec) or None on timeout/EOF."""
    end = time.time() + timeout
    while True:
        left = end - time.time()
        if left <= 0:
            return None
        try:
            item = Q.get(timeout=min(left, 0.5))
        except queue.Empty:
            continue
        if item is None:
            S["eof"] = True
            return None
        t, rec = item
        handle(t, rec)
        if pred(t, rec):
            return t, rec


def is_resp(i):
    return lambda t, r: r.get("type") == "response" and r.get("id") == i


try:
    send({"id": "st", "type": "get_state"})
    got = wait_for(is_resp("st"), 60)
    S["timings"]["spawn_to_get_state_response"] = got[0] if got else None
    if got:
        d = got[1].get("data") or {}
        state = {k: d.get(k) for k in ("thinkingLevel", "isStreaming", "sessionFile", "sessionId",
                                       "autoRetryEnabled", "autoCompactionEnabled", "messageCount")}
        mm = d.get("model")
        state["model"] = ({k: mm.get(k) for k in ("provider", "id", "api", "baseUrl", "reasoning")}
                          if isinstance(mm, dict) else mm)
        S["state"] = state
    if not got:
        raise SystemExit("no get_state response")
    t_prompt = rel()
    S["timings"]["prompt_sent"] = t_prompt
    send({"id": "p1", "type": "prompt", "message": A.prompt})
    gate_closed = False
    abort_sent = None
    followup_sent = False
    deadline = time.time() + A.timeout

    def done_pred(t, rec):
        global gate_closed, abort_sent, followup_sent
        typ = rec.get("type")
        if typ == "response" and rec.get("id") == "p1" and (rec.get("data") or {}).get("disposition") == "handled":
            S["notes"].append("prompt handled; no run")
            return True
        if typ == "response" and rec.get("id") in ("p1", "p2") and rec.get("success") is False:
            S["notes"].append(f"prompt rejected: {rec.get('error')}")
            return True
        if A.mode == "gate":
            if (not gate_closed and typ == "message_end" and (rec.get("message") or {}).get("role") == "assistant"
                    and ((rec["message"].get("usage") or {}).get("totalTokens") or 0) > 0):
                with open(A.gate_file, "w") as f:
                    f.write(A.gate_json)
                gate_closed = True
                S["timings"]["gate_closed"] = rel()
                S["timings"]["gate_closed_epoch"] = round(time.time(), 3)
            n_retry = sum(1 for x in S["retries"] if x["payload"].get("type") == "auto_retry_start")
            if gate_closed and abort_sent is None and (n_retry >= A.retries_before_abort
                                                       or rel() - S["timings"]["gate_closed"] > 15):
                abort_sent = rel()
                S["timings"]["abort_sent"] = abort_sent
                S["timings"]["abort_sent_epoch"] = round(time.time(), 3)
                send({"id": "ab", "type": "abort"})
            if typ == "agent_settled":
                if abort_sent is not None:
                    return True
                if gate_closed and not followup_sent:
                    followup_sent = True
                    S["notes"].append("model settled before a 2nd request; sent follow-up prompt")
                    send({"id": "p2", "type": "prompt", "message": A.followup})
                    return False
                if gate_closed:
                    return True
            return False
        return typ == "agent_settled"

    # The gate-mode predicate must also run on a timer (abort after 15 s even with no events).
    while True:
        got = wait_for(done_pred, 1.0)
        if got or S["eof"] or time.time() > deadline:
            break
        if A.mode == "gate":
            done_pred(rel(), {"type": "__tick__"})
    S["timings"]["settled_or_timeout"] = rel()
    if not got:
        S["notes"].append("TIMEOUT or EOF before agent_settled")
    if A.stats:
        send({"id": "stats", "type": "get_session_stats"})
        g = wait_for(is_resp("stats"), 20)
        S["stats"] = g[1].get("data") if g else None
    # drain briefly for any trailing events
    wait_for(lambda t, r: False, 0.5)
finally:
    t_close = rel()
    S["timings"]["stdin_closed"] = t_close
    with contextlib.suppress(OSError):
        PIN.close()
    try:
        proc.wait(timeout=10)
        S["timings"]["exit_after_stdin_close"] = round(rel() - t_close, 3)
    except subprocess.TimeoutExpired:
        S["notes"].append("pi did not exit within 10 s of stdin close; stopping scope")
        t_stop = rel()
        subprocess.run(["systemctl", "--user", "stop", A.unit + ".scope"], check=False)
        proc.wait(timeout=10)
        S["timings"]["scope_stop_seconds"] = round(rel() - t_stop, 3)
    S["exit_code"] = proc.returncode
    while not Q.empty():
        item = Q.get()
        if item:
            handle(*item)
    st = subprocess.run(["systemctl", "--user", "is-active", A.unit + ".scope"], capture_output=True, text=True)
    S["scope_after_exit"] = st.stdout.strip()
    S["seq"] = [f"{a}×{n}" if n > 1 else a for a, n in S["seq"]]
    print(json.dumps(S, indent=1))
    os.close(LOG_FD)
    os.close(ERR_FD)
    sys.exit(0)
