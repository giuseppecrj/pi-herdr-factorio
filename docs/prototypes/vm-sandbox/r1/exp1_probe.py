#!/usr/bin/env python3
"""F05 R1 experiment 1: exe.dev edge routing probes (HTTP/1.1, raw TLS).

Every request is an unauthenticated GET. The script sends no credentials.
For each probe it records the status, the server header, the x-trace-id
count, the fingerprint headers, a sha256 of the body and the backend it infers.
"""
import hashlib
import http.client
import json
import socket
import ssl

EDGE = "169.254.169.254"
L, G, A = "llm.int.exe.xyz", "github.int.exe.xyz", "api.github.com"
PATHS = ["/openai/v1/models", "/xai/v1/models", "/zen"]
KNOWN = {L, G}


def classify(h, body):
    server = h.get("server", "").lower()
    if "x-github-request-id" in h or "github" in server or "x-github-media-type" in h:
        return "github"
    try:
        j = json.loads(body)
    except Exception:
        j = None
    if isinstance(j, dict) and j.get("object") == "list" and isinstance(j.get("data"), list):
        ids = [str(m.get("id", "")) for m in j["data"] if isinstance(m, dict)]
        if any("grok" in i for i in ids):
            return "llm-xai"
        return "llm-openai"
    if any(k.startswith("openai-") for k in h) or "x-request-id" in h and "openai" in json.dumps(h):
        return "llm-openai?"
    return "other"


def probe(name, path, sni, hosts, target=None, extra=(), http10=False):
    target = target or path
    rec = {"name": name, "path": path, "sni": sni, "hosts": hosts, "target": target,
           "extra": [f"{k}: {v}" for k, v in extra]}
    try:
        raw = socket.create_connection((EDGE, 443), timeout=15)
        if sni in KNOWN:
            ctx = ssl.create_default_context()
        else:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        ctx.set_alpn_protocols(["http/1.1"])
        s = ctx.wrap_socket(raw, server_hostname=sni)
        lines = [f"GET {target} HTTP/1.{0 if http10 else 1}"]
        lines += [f"Host: {h}" for h in hosts]
        lines += [f"{k}: {v}" for k, v in extra]
        lines += ["User-Agent: f05-r1-probe", "Accept: */*", "Connection: close", "", ""]
        s.sendall("\r\n".join(lines).encode())
        r = http.client.HTTPResponse(s)
        r.begin()
        body = r.read()
        s.close()
        h = {}
        traces = 0
        for k, v in r.getheaders():
            kl = k.lower()
            if kl == "x-trace-id":
                traces += 1
            h.setdefault(kl, v)
        rec.update(status=r.status, server=h.get("server"), x_trace_id_count=traces,
                   ctype=h.get("content-type"), header_names=sorted({k.lower() for k, _ in r.getheaders()}),
                   body_len=len(body), body_sha256=hashlib.sha256(body).hexdigest()[:16],
                   snippet=body[:90].decode("utf-8", "replace").replace("\n", " "),
                   backend=classify(h, body))
    except Exception as e:  # record the failure, keep going
        rec.update(status="ERR", error=f"{type(e).__name__}: {e}"[:200], backend="none")
    print(json.dumps(rec), flush=True)
    return rec


def main():
    for P in PATHS:
        lp = P
        cases = [
            ("base:sni=L,host=L", L, [L]),
            ("base:sni=G,host=G", G, [G]),
            ("hostswap:sni=L,host=G", L, [G]),
            ("hostswap:sni=G,host=L", G, [L]),
            ("hostswap:sni=L,host=api.github.com", L, [A]),
            ("hostswap:sni=L,host=unknown.int.exe.xyz", L, ["unknown.int.exe.xyz"]),
            ("sni-none,host=L", None, [L]),
            ("sni-none,host=G", None, [G]),
            ("sni-other(unknown.int.exe.xyz),host=L", "unknown.int.exe.xyz", [L]),
            ("sni-other(unknown.int.exe.xyz),host=G", "unknown.int.exe.xyz", [G]),
            ("sni-upper(LLM.INT.EXE.XYZ),host=G", "LLM.INT.EXE.XYZ", [G]),
            ("host-port:sni=L,host=G:443", L, [G + ":443"]),
            ("host-port:sni=L,host=L:443", L, [L + ":443"]),
            ("host-port:sni=G,host=L:443", G, [L + ":443"]),
            ("host-port:sni=L,host=G:8443", L, [G + ":8443"]),
            ("host-dot:sni=L,host=G.", L, [G + "."]),
            ("host-dot:sni=L,host=L.", L, [L + "."]),
            ("host-dot:sni=G,host=L.", G, [L + "."]),
            ("host-case:sni=L,host=GITHUB.INT.EXE.XYZ", L, [G.upper()]),
            ("host-case:sni=L,host=LLM.INT.EXE.XYZ", L, [L.upper()]),
            ("host-case:sni=G,host=LLM.INT.EXE.XYZ", G, [L.upper()]),
            ("host-dup:sni=L,host=L+G", L, [L, G]),
            ("host-dup:sni=L,host=G+L", L, [G, L]),
            ("host-missing:sni=L", L, []),
        ]
        for name, sni, hosts in cases:
            probe(name, lp, sni, hosts)
        # forwarding headers
        probe("xfh:sni=L,host=L,XFH=G", lp, L, [L], extra=[("X-Forwarded-Host", G)])
        probe("xfh:sni=G,host=G,XFH=L", lp, G, [G], extra=[("X-Forwarded-Host", L)])
        probe("fwd:sni=L,host=L,Forwarded host=G", lp, L, [L], extra=[("Forwarded", f"host={G};proto=https")])
        probe("fwd:sni=G,host=G,Forwarded host=L", lp, G, [G], extra=[("Forwarded", f"host={L};proto=https")])
        probe("misc-fwd:sni=L,host=L,X-Original-Host/X-Host/X-Forwarded-Server=G", lp, L, [L],
              extra=[("X-Original-Host", G), ("X-Host", G), ("X-Forwarded-Server", G)])
        probe("misc-fwd:sni=L,host=L,X-Original-URL/X-Rewrite-URL=https://G/zen", lp, L, [L],
              extra=[("X-Original-URL", f"https://{G}/zen"), ("X-Rewrite-URL", f"https://{G}/zen")])
        # absolute-form request targets
        probe("absform:sni=L,host=L,target=https://G" + P, lp, L, [L], target=f"https://{G}{P}")
        probe("absform:sni=G,host=G,target=https://L" + P, lp, G, [G], target=f"https://{L}{P}")
        probe("absform:sni=L,host=G,target=https://L" + P, lp, L, [G], target=f"https://{L}{P}")
        probe("absform:sni=G,host=L,target=https://G" + P, lp, G, [L], target=f"https://{G}{P}")
        probe("absform-http:sni=L,host=L,target=http://G" + P, lp, L, [L], target=f"http://{G}{P}")
        probe("http10-nohost:sni=L", lp, L, [], http10=True)
        probe("http10-nohost:sni=G", lp, G, [], http10=True)


if __name__ == "__main__":
    main()
