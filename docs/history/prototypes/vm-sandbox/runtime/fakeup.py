#!/usr/bin/env python3
"""F05 exp 8 fake OpenAI Responses upstream (host side, 127.0.0.1 only, no real model).

The scenario is read from --scenario-file on every request, so the runner can switch it between Pi
runs. Scenarios mimic provider refusal / content-filter / error shapes:
  incomplete_content_filter  SSE, response.incomplete with incomplete_details.reason=content_filter
  failed_content_filter      SSE, response.failed with error {code: content_filter}
  refusal_part               SSE, completed message whose content is a Responses `refusal` part
  http400_content_policy     HTTP 400 JSON error, code content_policy_violation
  http500                    HTTP 500 JSON server_error (control: should be auto-retried)
"""
import argparse
import http.server
import json
import socketserver
import time

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, required=True)
ap.add_argument("--scenario-file", required=True)
A = ap.parse_args()

USAGE = {"input_tokens": 7, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 5,
         "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": 12}


def resp_obj(status, output=None, **extra):
    o = {"id": "resp_fake_1", "object": "response", "created_at": int(time.time()), "status": status,
         "model": "gpt-6.1-sol", "output": output or [], "usage": USAGE if status != "in_progress" else None,
         "error": None, "incomplete_details": None}
    o.update(extra)
    return o


def sse(events):
    out = []
    for i, e in enumerate(events):
        e = {**e, "sequence_number": i}
        out.append(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n")
    return "".join(out).encode()


REFUSAL = "I can't help with that."
MSG_ITEM_DONE = {"id": "msg_fake_1", "type": "message", "status": "completed", "role": "assistant",
                 "content": [{"type": "refusal", "refusal": REFUSAL}]}


def scenario_body(name):
    created = {"type": "response.created", "response": resp_obj("in_progress")}
    if name == "incomplete_content_filter":
        return 200, "text/event-stream", sse([created, {"type": "response.incomplete", "response": resp_obj(
            "incomplete", incomplete_details={"reason": "content_filter"})}])
    if name == "failed_content_filter":
        return 200, "text/event-stream", sse([created, {"type": "response.failed", "response": resp_obj(
            "failed", error={"code": "content_filter", "message": "The response was filtered due to the prompt triggering content management policy."})}])
    if name == "refusal_part":
        return 200, "text/event-stream", sse([
            created,
            {"type": "response.output_item.added", "output_index": 0,
             "item": {"id": "msg_fake_1", "type": "message", "status": "in_progress", "role": "assistant", "content": []}},
            {"type": "response.content_part.added", "item_id": "msg_fake_1", "output_index": 0, "content_index": 0,
             "part": {"type": "refusal", "refusal": ""}},
            {"type": "response.refusal.delta", "item_id": "msg_fake_1", "output_index": 0, "content_index": 0, "delta": REFUSAL},
            {"type": "response.refusal.done", "item_id": "msg_fake_1", "output_index": 0, "content_index": 0, "refusal": REFUSAL},
            {"type": "response.content_part.done", "item_id": "msg_fake_1", "output_index": 0, "content_index": 0,
             "part": {"type": "refusal", "refusal": REFUSAL}},
            {"type": "response.output_item.done", "output_index": 0, "item": MSG_ITEM_DONE},
            {"type": "response.completed", "response": resp_obj("completed", output=[MSG_ITEM_DONE])}])
    if name == "http400_content_policy":
        return 400, "application/json", json.dumps({"error": {
            "message": "Your request was rejected as a result of our safety system.",
            "type": "invalid_request_error", "param": None, "code": "content_policy_violation"}}).encode()
    if name == "http500":
        return 500, "application/json", json.dumps({"error": {
            "message": "The server had an error while processing your request.", "type": "server_error",
            "param": None, "code": None}}).encode()
    return 404, "text/plain", b"unknown scenario\n"


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # noqa: A002 - matches the base-class signature
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            self.rfile.read(n)
        try:
            with open(A.scenario_file) as f:
                name = f.read().strip()
        except OSError:
            name = ""
        code, ctype, body = scenario_body(name)
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)


class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


S(("127.0.0.1", A.port), H).serve_forever()
