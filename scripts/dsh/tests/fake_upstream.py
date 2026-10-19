"""Fake OpenRouter for test-dsh-run.sh: python3 fake_upstream.py PORTFILE REQFILE

Answers one POST with a short Anthropic-style SSE stream carrying usage, writes what it
received (path, auth headers, parsed body) to REQFILE, and keeps serving until killed."""
import json, sys
from http.server import HTTPServer, BaseHTTPRequestHandler

PORTFILE, REQFILE = sys.argv[1], sys.argv[2]
EVENTS = [
    {"type": "message_start", "message": {"id": "m1", "provider": "FakeInfra", "usage": {"input_tokens": 3}}},
    {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "hi"}},
    {"type": "message_delta", "usage": {"output_tokens": 7, "cost": 0.5}},
    {"type": "message_stop"},
]


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        with open(REQFILE, "w") as f:
            json.dump({"path": self.path, "auth": self.headers.get("authorization"),
                       "x_api_key": self.headers.get("x-api-key"), "body": body}, f)
        data = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in EVENTS).encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


srv = HTTPServer(("127.0.0.1", 0), H)
with open(PORTFILE, "w") as f:
    f.write(str(srv.server_address[1]))
srv.serve_forever()
