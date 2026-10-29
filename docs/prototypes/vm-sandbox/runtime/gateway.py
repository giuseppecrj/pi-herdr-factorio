#!/usr/bin/env python3
"""F05 runtime prototype gateway (R1 gateway + budget gate + usage logging + fake upstream).

Changes from the R1 gateway (proto-r1/gateway.py):
- Budget gate: when --gate-file exists, every model-route request (/openai/v1/*, /xai/v1/*)
  is answered by the gateway itself (status/body from the file's JSON) and NO upstream
  connection is opened. Logged as decision="gated".
- --auto-gate-tokens N: after cumulative upstream total_tokens >= N the gateway writes the
  gate file itself (a safety cap for the prototype's token budget).
- Each forwarded POST logs a request summary (model, tool names, input items) and, for SSE
  Responses streams, the terminal event's status and usage.
- --fake-openai-port P: route /openai/v1/* to a host-side fake upstream on 127.0.0.1:P
  (refusal experiment only). Logged with route=fake.
- Records carry a float epoch "t" for ordering against driver events.

The original R1 docstring follows.

F05 R1 prototype gateway: a throwaway, path-routed reverse proxy on a unix socket.

Policy:
- Routing uses the path prefix only. The client's Host, SNI and absolute
  target never select an upstream.
- The gateway builds each upstream request from scratch. Host and SNI are
  fixed per route, and the only client headers copied are Accept and
  Content-Type.
- It answers 403 when the client sends X-Forwarded-*, Forwarded, other
  forwarding headers, a non-local Host, an absolute or authority-form
  target, CONNECT, a dot-segment or encoded-traversal path, or an unknown
  route or method.
- It never follows redirects. http.client has no redirect logic, so a 3xx
  goes back to the client unchanged.
- It logs one JSON line per request. The line includes the upstream Host
  header and the SNI actually used: ssl.SSLSocket.server_hostname, read
  after the handshake.

Routes:
  /openai/v1/*  GET, POST -> https://llm.int.exe.xyz/openai/v1/*
  /xai/v1/*     GET, POST -> https://llm.int.exe.xyz/xai/v1/*
  /npm/*        GET, HEAD -> https://registry.npmjs.org/*
  /__fixture/*  GET       -> http://127.0.0.1:<fixture-port>/__fixture/*  (only with --fixture-port; for the 3xx test)
"""
import argparse
import http.client
import http.server
import itertools
import json
import os
import re
import socketserver
import ssl
import sys
import threading
import time
import urllib.parse

LLM = "llm.int.exe.xyz"
NPM = "registry.npmjs.org"
COPY_HEADERS = ("accept", "content-type")
FORBIDDEN_HEADER_RE = re.compile(
    r"^(x-forwarded-.*|forwarded|x-original-host|x-host|x-original-url|x-rewrite-url|x-http-method-override|proxy-.*)$", re.IGNORECASE)
HOP = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "content-length",
       "proxy-authenticate", "proxy-authorization"}
PATH_CHARS = re.compile(r"^/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$")
MAX_BODY = 8 << 20
MAX_RESP = 64 << 20

ARGS = argparse.Namespace(log="", fixture_port=0, client_host=None, socket="", gate_file="",
                          auto_gate_tokens=0, fake_openai_port=0, mark=[])
LOG_LOCK = threading.Lock()
IDS = itertools.count(1)
TOKENS = {"total": 0}
DEFAULT_GATE = {"status": 429, "body": {"error": {"message": "f05 budget gate closed: admission denied",
                                                  "type": "budget_gate", "code": "budget_gate_closed"}}}


def gate_state():
    """Return the gate spec dict if the gate is closed, else None."""
    if not ARGS.gate_file or not os.path.exists(ARGS.gate_file):
        return None
    try:
        with open(ARGS.gate_file) as f:
            txt = f.read().strip()
        return json.loads(txt) if txt else DEFAULT_GATE
    except (OSError, ValueError):
        return DEFAULT_GATE


def summarize_request(body):
    try:
        j = json.loads(body)
    except (ValueError, TypeError):
        return {"json": False, "bytes": len(body or b"")}
    tools = [t.get("name") or (t.get("function") or {}).get("name") or t.get("type") for t in (j.get("tools") or [])]
    inp = j.get("input")
    return {"bytes": len(body), "model": j.get("model"), "stream": j.get("stream"), "tools": tools,
            "keys": sorted(j.keys()), "markers": [m for m in ARGS.mark if m.encode() in body],
            "input_items": len(inp) if isinstance(inp, list) else None,
            "instructions_chars": len(j.get("instructions") or ""),
            "reasoning": j.get("reasoning"), "max_output_tokens": j.get("max_output_tokens")}


def summarize_sse(data):
    """Find the terminal Responses event in an SSE body; return status/usage/error."""
    final = None
    types = []
    for line in data.decode("utf-8", "replace").splitlines():
        if not line.startswith("data:"):
            continue
        d = line[5:].strip()
        if not d or d == "[DONE]":
            continue
        try:
            ev = json.loads(d)
        except ValueError:
            continue
        types.append(ev.get("type"))
        if ev.get("type") in ("response.completed", "response.incomplete", "response.failed"):
            final = ev.get("response") or {}
        elif ev.get("type") == "error":
            final = final or {"status": "error-event", "error": ev}
    if final is None:
        return {"sse_events": len(types), "terminal": None}
    return {"sse_events": len(types), "terminal": final.get("status"), "usage": final.get("usage"),
            "incomplete_details": final.get("incomplete_details"), "error": final.get("error")}


def log(rec):
    with LOG_LOCK, open(ARGS.log, "a") as f:
        f.write(json.dumps(rec, sort_keys=True) + "\n")


def route_for(path):
    """Return (scheme, host, port, upstream_path, allowed_methods) or None."""
    # Fake-upstream mode must be checked FIRST and must disable every real model route: in the first
    # exp8 run this check sat after the real route and five "fake" requests reached the real model.
    if ARGS.fake_openai_port:
        if path.startswith("/openai/v1/"):
            return ("http", "127.0.0.1", ARGS.fake_openai_port, path, {"GET", "POST"})
        if path.startswith("/xai/v1/"):
            return None
    if path.startswith(("/openai/v1/", "/xai/v1/")):
        return ("https", LLM, 443, path, {"GET", "POST"})
    if path.startswith("/npm/"):
        return ("https", NPM, 443, path[len("/npm"):], {"GET", "HEAD"})
    if ARGS.fixture_port and path.startswith("/__fixture/"):
        return ("http", "127.0.0.1", ARGS.fixture_port, path, {"GET"})
    return None


def path_problem(target):
    if not target.startswith("/"):
        return "non-origin-form request target"
    if target.startswith("//"):
        return "network-path target"
    path, _, _query = target.partition("?")
    if not PATH_CHARS.match(path):
        return "illegal characters in path"
    if "%25" in path.lower():
        return "double percent-encoding"
    decoded = urllib.parse.unquote(path)
    if "\\" in decoded or "//" in decoded or any(ord(c) < 0x21 for c in decoded):
        return "illegal sequence in decoded path"
    if any(seg in (".", "..") for seg in decoded.split("/")):
        return "dot segment"
    if "#" in target:
        return "fragment in target"
    return None


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 60
    server_version = "f05-gateway"
    sys_version = ""

    def address_string(self):
        return "unix"

    def log_message(self, format, *args):
        pass

    def handle_one_request(self):
        self.raw_requestline = self.rfile.readline(65537)
        if not self.raw_requestline:
            self.close_connection = True
            return
        if len(self.raw_requestline) > 65536:
            self.send_error(414)
            return
        if not self.parse_request():
            return
        self.close_connection = True
        try:
            self.handle_any()
        except Exception as e:  # noqa: BLE001 - one bad request must not kill the server
            self.rec["error"] = f"{type(e).__name__}: {e}"[:300]
            log(self.rec)
            try:
                self.reply(502, "f05-gateway: upstream error\n")
            except OSError as e2:  # client already gone; the request is logged above
                print(f"f05-gateway: reply failed: {e2}", file=sys.stderr)
        self.wfile.flush()

    def reply(self, status, text, extra=()):
        body = text.encode()
        self.send_response(status)
        for k, v in extra:
            self.send_header(k, v)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def deny(self, reason):
        self.rec.update(decision="deny", reason=reason, upstream=None, status=403)
        log(self.rec)
        self.reply(403, f"f05-gateway: denied: {reason}\n")

    def handle_any(self):
        hosts = self.headers.get_all("Host") or []
        self.rec = {
            "id": next(IDS), "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "t": round(time.time(), 3),
            "method": self.command,
            "client_target": self.path, "client_host": hosts,
            "client_header_names": sorted({k.lower() for k in self.headers}),
        }
        if self.command == "CONNECT":
            return self.deny("CONNECT not supported")
        prob = path_problem(self.path)
        if prob:
            return self.deny(prob)
        if len(hosts) != 1 or hosts[0].lower() not in ARGS.client_host:
            return self.deny("client Host is not the local forwarder")
        bad = [k for k in self.headers if FORBIDDEN_HEADER_RE.match(k)]
        if bad:
            return self.deny("forwarding/proxy header present: " + ",".join(sorted({b.lower() for b in bad})))
        r = route_for(self.path)
        if r is None:
            return self.deny("no route")
        scheme, host, port, up_path, methods = r
        if self.command not in methods:
            return self.deny(f"method {self.command} not allowed on route")
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            return self.deny("chunked request body not supported")
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            return self.deny("request body too large")
        body = self.rfile.read(n) if n else None
        if body is not None and self.command == "POST":
            self.rec["request"] = summarize_request(body)

        model_route = self.path.startswith(("/openai/v1/", "/xai/v1/"))
        gate = gate_state() if model_route and scheme == "https" else None
        if gate is not None:
            status = int(gate.get("status", 429))
            gbody = json.dumps(gate.get("body", DEFAULT_GATE["body"])).encode()
            self.rec.update(decision="gated", upstream=None, status=status, gate_body=gate.get("body"))
            log(self.rec)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(gbody)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(gbody)
            return

        send = [("Host", host if scheme == "https" else "fixture.local")]
        for k in COPY_HEADERS:
            v = self.headers.get(k)
            if v is not None:
                send.append((k.title(), v))
        send += [("User-Agent", "f05-gateway/0"), ("Accept-Encoding", "identity"), ("Connection", "close")]
        if body is not None:
            send.append(("Content-Length", str(len(body))))
        dropped = sorted({k.lower() for k in self.headers} - set(COPY_HEADERS) - {"content-length"})

        if scheme == "https":
            conn = http.client.HTTPSConnection(host, port, context=ssl.create_default_context(), timeout=60)
        else:
            conn = http.client.HTTPConnection(host, port, timeout=10)
        conn.connect()
        up = {"scheme": scheme, "connect_host": host, "port": port, "path_sent": up_path,
              "peer": conn.sock.getpeername()[0]}
        tls_sock = conn.sock
        if scheme == "https" and isinstance(tls_sock, ssl.SSLSocket):
            cert = tls_sock.getpeercert() or {}
            sans = cert.get("subjectAltName", ())
            up.update(sni_sent=tls_sock.server_hostname, tls=tls_sock.version(),
                      cert_san=[str(v) for t, v in sans if t == "DNS"][:4])
        else:
            up["sni_sent"] = None
        conn.putrequest(self.command, up_path, skip_host=True, skip_accept_encoding=True)
        for k, v in send:
            conn.putheader(k, v)
        conn.endheaders(body)
        resp = conn.getresponse()
        data = resp.read(MAX_RESP) if self.command != "HEAD" else b""
        up.update(host_header_sent=send[0][1], headers_sent=[k for k, _ in send], status=resp.status,
                  location=resp.getheader("Location"), resp_bytes=len(data),
                  x_trace_id_count=sum(1 for k, _ in resp.getheaders() if k.lower() == "x-trace-id"))
        conn.close()
        route = "fake" if (scheme == "http" and ARGS.fake_openai_port and port == ARGS.fake_openai_port) \
            else self.path.split("/")[1]
        self.rec.update(decision="forward", route=route, dropped_client_headers=dropped,
                        upstream=up, status=resp.status)
        if data[:6] in (b"event:", b"data: ") or (resp.getheader("Content-Type") or "").startswith("text/event-stream"):
            self.rec["response"] = summarize_sse(data)
        elif self.command == "POST":
            self.rec["response"] = {"body_head": data[:300].decode("utf-8", "replace")}
        usage = (self.rec.get("response") or {}).get("usage") or {}
        if route != "fake" and usage.get("total_tokens"):
            with LOG_LOCK:
                TOKENS["total"] += int(usage["total_tokens"])
                self.rec["cumulative_tokens"] = TOKENS["total"]
            if ARGS.auto_gate_tokens and TOKENS["total"] >= ARGS.auto_gate_tokens and ARGS.gate_file \
                    and not os.path.exists(ARGS.gate_file):
                try:
                    with open(ARGS.gate_file, "w") as f:
                        json.dump({"status": 429, "body": {"error": {
                            "message": "f05 safety cap reached: out of budget", "code": "budget_gate_closed"}}}, f)
                    self.rec["auto_gate_closed"] = True
                except OSError as e:  # a failed close must be visible in the log, not crash the request
                    self.rec["auto_gate_error"] = f"{type(e).__name__}: {e}"[:200]
        log(self.rec)

        self.send_response_only(resp.status, resp.reason)  # no gateway Server/Date; upstream's are copied
        for k, v in resp.getheaders():
            if k.lower() not in HOP:
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--socket", required=True)
    p.add_argument("--log", required=True)
    p.add_argument("--client-host", action="append", required=True,
                   help="Host values accepted from the in-sandbox forwarder, e.g. 127.0.0.1:18080")
    p.add_argument("--fixture-port", type=int, default=0)
    p.add_argument("--gate-file", default="")
    p.add_argument("--auto-gate-tokens", type=int, default=0)
    p.add_argument("--fake-openai-port", type=int, default=0)
    p.add_argument("--mark", action="append", default=[], help="log whether each request body contains this string")
    p.parse_args(namespace=ARGS)
    ARGS.client_host = {h.lower() for h in ARGS.client_host}
    if os.path.exists(ARGS.socket):
        os.unlink(ARGS.socket)
    os.umask(0o077)
    srv = Server(ARGS.socket, Handler)
    print(f"f05-gateway listening on {ARGS.socket}", file=sys.stderr, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
