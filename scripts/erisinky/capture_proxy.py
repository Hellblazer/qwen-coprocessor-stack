#!/usr/bin/env python3
"""Logging pass-through proxy for OpenAI-compatible endpoints (bead gj36.1.2).

Listens on 127.0.0.1, forwards every request unchanged to --upstream, streams
the response back unchanged (SSE included), and appends one JSON line per
request to --log: seq, ts, method, path, body (parsed JSON). Request bodies
only: headers are never logged because they carry API keys. Stdlib only.

Usage:
    capture_proxy.py --listen-port 8099 --upstream http://127.0.0.1:1235 --log cap.jsonl

If --upstream carries a path prefix (e.g. .../v1) and the client path already
starts with that prefix, the prefix is not applied twice.
"""
import argparse
import http.client
import json
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
        """Append one log line; returns its seq."""
        if not raw:
            body = None
        else:
            try:
                body = json.loads(raw)
            except ValueError:
                body = raw.decode("utf-8", errors="replace")
        with self._lock:
            self._seq += 1
            line = {
                "seq": self._seq,
                "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + f".{int(time.time() * 1000) % 1000:03d}Z",
                "method": method,
                "path": path,
                "body": body,
            }
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(line, ensure_ascii=False) + "\n")
            return self._seq

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

    def _forward(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        self.server.record(self.command, self.path, raw)

        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}
        conn = self.server.connect()
        try:
            conn.request(self.command, self.server.upstream_path(self.path),
                         body=raw or None, headers=headers)
            resp = conn.getresponse()
        except OSError as e:
            conn.close()
            msg = json.dumps({"error": f"upstream unreachable: {type(e).__name__}"}).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
            return

        try:
            self.send_response(resp.status, resp.reason)
            clen = resp.getheader("Content-Length")
            for k, v in resp.getheaders():
                if k.lower() not in HOP_BY_HOP and k.lower() != "content-length":
                    self.send_header(k, v)
            if clen is not None:
                self.send_header("Content-Length", clen)
            else:
                self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            while True:
                chunk = resp.read1(65536)
                if not chunk:
                    break
                if clen is None:
                    self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                else:
                    self.wfile.write(chunk)
                self.wfile.flush()
            if clen is None:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        finally:
            conn.close()

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_HEAD = _forward


def make_server(listen_port, upstream, log_path):
    return CaptureServer(("127.0.0.1", listen_port), upstream, log_path)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
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
