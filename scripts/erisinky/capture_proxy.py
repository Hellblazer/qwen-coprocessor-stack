#!/usr/bin/env python3
"""Logging pass-through proxy for OpenAI-compatible endpoints (bead gj36.1.2).

Listens on 127.0.0.1, forwards every request unchanged to --upstream, streams
the response back unchanged (SSE included), and appends one JSON line per
request to --log: seq, ts, method, path, body (parsed JSON). Request bodies
only: headers are never logged because they carry API keys. The log is pure
ASCII (non-ASCII and lone UTF-16 surrogates are written as \\u escapes). A
logging failure goes to stderr and the request is still forwarded. Stdlib only.

Usage:
    capture_proxy.py --listen-port 8099 --upstream http://127.0.0.1:1235 --log cap.jsonl

If --upstream carries a path prefix (e.g. .../v1) and the client path already
starts with that prefix, the prefix is not applied twice.
"""
import argparse
import http.client
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "host",
}


class CaptureServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128  # the default 5 resets connects when clients burst

    def __init__(self, addr, upstream, log_path):
        super().__init__(addr, _Handler)
        u = urlsplit(upstream)
        if u.scheme not in ("http", "https") or not u.hostname:
            raise ValueError(f"bad upstream URL: {upstream!r}")
        self.up_scheme = u.scheme
        self.up_host = u.hostname
        self.up_port = u.port or (443 if u.scheme == "https" else 80)
        self.up_prefix = u.path.rstrip("/")
        self.log_path = log_path
        self._lock = threading.Lock()
        self._seq = 0

    def record(self, method, path, raw):
        """Append one log line; returns its seq. seq is consumed only by a
        write that succeeded, so a failure leaves no gap."""
        if not raw:
            body = None
        else:
            try:
                body = json.loads(raw)
            except ValueError:
                body = raw.decode("utf-8", errors="replace")
        t = time.time()  # one read: seconds and millis must agree
        ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int((t - int(t)) * 1000):03d}Z"
        with self._lock:
            seq = self._seq + 1
            line = {"seq": seq, "ts": ts, "method": method, "path": path, "body": body}
            # ensure_ascii: a lone surrogate (JSON \ud83d) cannot be encoded as UTF-8
            data = json.dumps(line, ensure_ascii=True) + "\n"
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(data)
            self._seq = seq
            return seq

    def record_safely(self, method, path, raw):
        """record(), but a logging failure is reported on stderr, not raised."""
        try:
            self.record(method, path, raw)
        except Exception as e:  # noqa: BLE001 - the request must still be forwarded
            print(f"capture_proxy: log write failed: {type(e).__name__}: {e}", file=sys.stderr, flush=True)

    def upstream_path(self, path):
        if self.up_prefix and not (path == self.up_prefix or path.startswith(self.up_prefix + "/")):
            return self.up_prefix + path
        return path

    def connect(self):
        cls = http.client.HTTPSConnection if self.up_scheme == "https" else http.client.HTTPConnection
        return cls(self.up_host, self.up_port, timeout=600)


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # no stderr noise; headers must never be echoed
        pass

    def _reply_error(self, status, message):
        msg = json.dumps({"error": message}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(msg)))
        self.end_headers()
        self.wfile.write(msg)

    def _forward(self):
        cl = self.headers.get("Content-Length")
        if cl is None:
            length = 0
        elif cl.strip().isascii() and cl.strip().isdigit():
            length = int(cl)
        else:
            self.close_connection = True  # body framing is unknown
            self._reply_error(400, "invalid Content-Length")
            return
        raw = self.rfile.read(length) if length else b""
        self.server.record_safely(self.command, self.path, raw)

        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}
        conn = self.server.connect()
        try:
            conn.request(self.command, self.server.upstream_path(self.path),
                         body=raw or None, headers=headers)
            resp = conn.getresponse()
        except OSError as e:
            conn.close()
            self._reply_error(502, f"upstream unreachable: {type(e).__name__}")
            return

        try:
            # send_response_only: send_response would add Server and Date, and
            # the upstream's own are forwarded below.
            self.send_response_only(resp.status, resp.reason)
            clen = resp.getheader("Content-Length")
            no_body = self.command == "HEAD" or resp.status < 200 or resp.status in (204, 304)
            for k, v in resp.getheaders():
                if k.lower() not in HOP_BY_HOP and k.lower() != "content-length":
                    self.send_header(k, v)
            if clen is not None:
                self.send_header("Content-Length", clen)
            elif not no_body:
                self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            if no_body:
                return
            sent = 0
            while True:
                chunk = resp.read1(65536)
                if not chunk:
                    break
                sent += len(chunk)
                if clen is None:
                    self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                else:
                    self.wfile.write(chunk)
                self.wfile.flush()
            if clen is None:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            elif clen.strip().isdigit() and sent < int(clen):
                # upstream hung up early: the client is still waiting for the
                # rest of a Content-Length body, so hang up on it too
                self.close_connection = True
        except (ConnectionError, TimeoutError, http.client.IncompleteRead):
            self.close_connection = True
        finally:
            conn.close()

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_HEAD = _forward


def make_server(listen_port, upstream, log_path):
    return CaptureServer(("127.0.0.1", listen_port), upstream, log_path)


def main():
    ap = argparse.ArgumentParser(description=((__doc__ or "").splitlines() or [""])[0])
    ap.add_argument("--listen-port", type=int, default=8099)
    ap.add_argument("--upstream", required=True, help="upstream base URL, e.g. http://127.0.0.1:1235")
    ap.add_argument("--log", required=True, help="JSONL file to append request bodies to")
    args = ap.parse_args()
    srv = make_server(args.listen_port, args.upstream, args.log)
    print(f"capture_proxy: 127.0.0.1:{srv.server_port} -> {args.upstream}, log {args.log}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
