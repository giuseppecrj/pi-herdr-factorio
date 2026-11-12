#!/usr/bin/env python3
"""Host-side 3xx fixture for experiment 3: a stand-in upstream that answers with redirects.

No real allowed upstream returned a 3xx to a harmless GET (see summary.md).
The gateway reaches this fixture through its prototype-only /__fixture/ route.
"""
import http.server
import sys

REDIRECTS = {
    "/__fixture/redir-github": "https://github.int.exe.xyz/zen",
    "/__fixture/redir-api": "https://api.github.com/zen",
    "/__fixture/redir-local": "/openai/v1/models",
}


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        loc = REDIRECTS.get(self.path)
        if loc is None:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = f"redirect to {loc}\n".encode()
        self.send_response(302)
        self.send_header("Location", loc)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        sys.stderr.write("fixture: " + (format % args) + "\n")


http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
