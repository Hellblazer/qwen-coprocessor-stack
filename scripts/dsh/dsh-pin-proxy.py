"""Loopback proxy between dsh and OpenRouter's Anthropic-format endpoint.

Pins OpenRouter routing to the providers in DSH_PROVIDER (comma-separated, no
fallbacks) on every /v1/messages request, streams the response back unchanged,
and appends one JSON line per request to USAGE with the usage OpenRouter
reported (tokens and cost). Request bodies and auth headers are never written.

Usage: python3 dsh-pin-proxy.py USAGE PORTFILE   (listens on 127.0.0.1, port 0)
"""
import http.client, json, os, ssl, sys, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

USAGE, PORTFILE = sys.argv[1], sys.argv[2]
UPSTREAM_HOST, UPSTREAM_PATH = "openrouter.ai", "/api"
PIN = [p for p in os.environ.get("DSH_PROVIDER", "DeepInfra").split(",") if p]
HOP = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade",
       "proxy-authorization", "proxy-authenticate", "host", "content-length", "accept-encoding"}
lock = threading.Lock()


def merge(acc, u):
    for k, v in (u or {}).items():
        if isinstance(v, (int, float)):
            acc[k] = v
        elif isinstance(v, dict):
            acc.setdefault(k, {}).update(v)


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _forward(self, method):
        raw = self.rfile.read(int(self.headers.get("content-length", 0) or 0))
        hdrs = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        is_msg = self.path.startswith("/v1/messages") and "count_tokens" not in self.path
        stream = False
        if is_msg:
            body = json.loads(raw)
            body["provider"] = {"order": PIN, "allow_fallbacks": False}
            stream = bool(body.get("stream"))
            raw = json.dumps(body).encode()
        t0 = time.time()
        c = http.client.HTTPSConnection(UPSTREAM_HOST, 443, timeout=900,
                                        context=ssl.create_default_context())
        c.request(method, UPSTREAM_PATH + self.path, body=raw, headers=hdrs)
        r = c.getresponse()
        self.send_response(r.status)
        for k, v in r.getheaders():
            if k.lower() not in HOP:
                self.send_header(k, v)
        self.send_header("transfer-encoding", "chunked")
        self.end_headers()
        buf = b""
        while True:
            chunk = r.read1(65536)
            if not chunk:
                break
            self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
            self.wfile.flush()
            if is_msg:
                buf += chunk
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()
        c.close()
        if not is_msg:
            return
        usage, text = {}, buf.decode("utf-8", "replace")
        if stream:
            for line in text.splitlines():
                if line.startswith("data:"):
                    try:
                        ev = json.loads(line[5:])
                    except ValueError:
                        continue
                    if ev.get("type") == "message_start":
                        merge(usage, ev["message"].get("usage"))
                    elif ev.get("type") == "message_delta":
                        merge(usage, ev.get("usage"))
        else:
            try:
                merge(usage, json.loads(text).get("usage"))
            except ValueError:
                pass
        rec = {"t": round(t0, 2), "status": r.status, "wall": round(time.time() - t0, 2), "usage": usage}
        if r.status >= 400:
            rec["body_head"] = text[:300]
        with lock, open(USAGE, "a") as f:
            f.write(json.dumps(rec) + "\n")

    def do_POST(self):
        self._forward("POST")

    def do_GET(self):
        self._forward("GET")


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
with open(PORTFILE, "w") as f:
    f.write(str(srv.server_address[1]))
srv.serve_forever()
