"""Loopback proxy between dsh and OpenRouter's Anthropic-format endpoint.

Holds the OpenRouter key, read from the first line of stdin so it is in no
process environment: dsh is given a dummy key, and the proxy replaces whatever
auth headers it sends with the real one. Forwards only POST /v1/messages* and
GET /v1/models*, and forces every message request's model to DSH_MODEL, so a
session cannot use the port to spend the key on another model or read the
account. Pins OpenRouter routing to the providers in DSH_PROVIDER (comma-separated, no
fallbacks) on every /v1/messages request, streams the response back, and
appends one JSON line per request to USAGE with the usage OpenRouter reported
(tokens, cost, provider when present). Request bodies and keys are never written.

Usage: printf '%s\n' "$KEY" | DSH_MODEL=... python3 dsh-pin-proxy.py USAGE PORTFILE
       (listens on 127.0.0.1, port 0)
"""
import http.client, json, os, ssl, sys, threading, time, urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

USAGE, PORTFILE = sys.argv[1], sys.argv[2]
# DSH_UPSTREAM exists for the offline tests (a local http server); the default is the only
# production value.
UPSTREAM = urllib.parse.urlsplit(os.environ.get("DSH_UPSTREAM", "https://openrouter.ai/api"))
UPSTREAM_PATH = UPSTREAM.path.rstrip("/")
if UPSTREAM.scheme != "https" and UPSTREAM.hostname not in ("127.0.0.1", "localhost", "::1"):
    sys.exit("dsh-pin-proxy: DSH_UPSTREAM must be https unless it is loopback")
KEY = sys.stdin.readline().strip()
MODEL = os.environ.get("DSH_MODEL", "")
PIN = [p.strip() for p in os.environ.get("DSH_PROVIDER", "DeepInfra").split(",") if p.strip()]
if not KEY:
    sys.exit("dsh-pin-proxy: no key on stdin")
if not MODEL:
    sys.exit("dsh-pin-proxy: DSH_MODEL not set")
if not PIN:
    sys.exit("dsh-pin-proxy: DSH_PROVIDER names no provider")
HOP = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade",
       "proxy-authorization", "proxy-authenticate", "host", "content-length", "accept-encoding",
       "authorization", "x-api-key"}
lock = threading.Lock()


def merge(acc, u):
    for k, v in (u or {}).items():
        if isinstance(v, (int, float)):
            acc[k] = v
        elif isinstance(v, dict):
            acc.setdefault(k, {}).update(v)


def parse_usage(text, stream):
    usage, provider = {}, None
    try:
        if stream:
            for line in text.splitlines():
                if not line.startswith("data:"):
                    continue
                try:
                    ev = json.loads(line[5:])
                except ValueError:
                    continue
                if not isinstance(ev, dict):
                    continue
                if ev.get("type") == "message_start" and isinstance(ev.get("message"), dict):
                    merge(usage, ev["message"].get("usage"))
                    provider = ev["message"].get("provider") or provider
                elif ev.get("type") == "message_delta":
                    merge(usage, ev.get("usage"))
        else:
            d = json.loads(text)
            if isinstance(d, dict):
                merge(usage, d.get("usage"))
                provider = d.get("provider")
    except (ValueError, AttributeError, TypeError):
        pass
    return usage, provider


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _error(self, status, msg):
        body = json.dumps({"type": "error", "error": {"type": "proxy_error", "message": msg}}).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _log(self, rec):
        with lock, open(USAGE, "a") as f:
            f.write(json.dumps(rec) + "\n")

    def _forward(self, method):
        raw = self.rfile.read(int(self.headers.get("content-length", 0) or 0))
        hdrs = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        hdrs["Authorization"] = "Bearer " + KEY
        is_msg = self.path.startswith("/v1/messages") and "count_tokens" not in self.path
        allowed = "/v1/messages" if method == "POST" else "/v1/models"
        if not self.path.startswith(allowed):
            return self._error(403, f"proxy does not forward {method} {self.path}")
        stream = False
        if is_msg:
            try:
                body = json.loads(raw)
                if not isinstance(body, dict):
                    raise ValueError("request body is not a JSON object")
            except ValueError as e:
                return self._error(400, f"unpinnable request: {e}")
            body["provider"] = {"order": PIN, "allow_fallbacks": False}
            body["model"] = MODEL
            stream = bool(body.get("stream"))
            raw = json.dumps(body).encode()
        t0 = time.time()
        try:
            if UPSTREAM.scheme == "https":
                c = http.client.HTTPSConnection(UPSTREAM.hostname, UPSTREAM.port or 443, timeout=900,
                                                context=ssl.create_default_context())
            else:
                c = http.client.HTTPConnection(UPSTREAM.hostname, UPSTREAM.port or 80, timeout=900)
            c.request(method, UPSTREAM_PATH + self.path, body=raw, headers=hdrs)
            r = c.getresponse()
        except (OSError, ValueError, http.client.HTTPException) as e:
            if is_msg:
                self._log({"t": round(t0, 2), "status": 502, "error": type(e).__name__, "usage": {}})
            return self._error(502, f"upstream unreachable: {type(e).__name__}")
        self.send_response(r.status)
        for k, v in r.getheaders():
            if k.lower() not in HOP:
                self.send_header(k, v)
        self.send_header("transfer-encoding", "chunked")
        self.end_headers()
        buf, rec = b"", None
        try:
            while True:
                chunk = r.read1(65536)
                if not chunk:
                    break
                if is_msg:
                    buf += chunk
                self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.flush()
            if is_msg:
                # Log before the terminal chunk, so the record exists by the time dsh sees the reply end.
                text = buf.decode("utf-8", "replace")
                usage, provider = parse_usage(text, stream)
                rec = {"t": round(t0, 2), "status": r.status, "wall": round(time.time() - t0, 2),
                       "provider": provider, "usage": usage}
                if r.status >= 400:
                    rec["body_head"] = text[:300]
                self._log(rec)
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            if is_msg and rec is None:
                usage, provider = parse_usage(buf.decode("utf-8", "replace"), stream)
                self._log({"t": round(t0, 2), "status": r.status, "client_gone": True,
                           "provider": provider, "usage": usage})
        finally:
            c.close()

    def do_POST(self):
        self._forward("POST")

    def do_GET(self):
        self._forward("GET")


def exit_with_parent(parent):
    # The launcher kills the proxy on exit; this covers a launcher that was SIGKILLed.
    while os.getppid() == parent:
        time.sleep(2)
    os._exit(0)


threading.Thread(target=exit_with_parent, args=(os.getppid(),), daemon=True).start()
srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
with open(PORTFILE + ".tmp", "w") as f:
    f.write(str(srv.server_address[1]))
os.replace(PORTFILE + ".tmp", PORTFILE)
srv.serve_forever()
