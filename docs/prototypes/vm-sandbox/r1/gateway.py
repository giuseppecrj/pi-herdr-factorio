#!/usr/bin/env python3
"""F05 R1 prototype gateway: a throwaway, path-routed reverse proxy on a unix socket.

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

ARGS = argparse.Namespace(log="", fixture_port=0, client_host=None, socket="")
LOG_LOCK = threading.Lock()
IDS = itertools.count(1)


def log(rec):
    with LOG_LOCK, open(ARGS.log, "a") as f:
        f.write(json.dumps(rec, sort_keys=True) + "\n")


def route_for(path):
    """Return (scheme, host, port, upstream_path, allowed_methods) or None."""
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
            "id": next(IDS), "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "method": self.command,
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
        self.rec.update(decision="forward", route=self.path.split("/")[1], dropped_client_headers=dropped,
                        upstream=up, status=resp.status)
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
