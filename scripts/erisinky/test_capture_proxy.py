"""Tests for capture_proxy (beads gj36.1.2, gj36.1.4). Stdlib only, offline, port 0."""
import contextlib
import http.client
import io
import itertools
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import capture_proxy  # noqa: E402

SSE_CHUNKS = [
    b'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
    b'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
    b"data: [DONE]\n\n",
]
SSE_BYTES = b"".join(SSE_CHUNKS)
JSON_REPLY = b'{"id":"x","choices":[{"message":{"content":"hi"}}]}'
MODELS_REPLY = b'{"object":"list","data":[{"id":"m1"}]}'

SECRETS = {
    "Authorization": "Bearer sk-secret-key-AAA111",
    "X-Api-Key": "xapikey-BBB222",
    "Cookie": "session=cookie-CCC333",
    "Proxy-Authorization": "Basic proxyauth-DDD444",
}


class FakeUpstream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    seen = []  # (method, path, auth header, raw body)
    gate = None  # threading.Event: a streaming reply pauses on it after chunk 1

    def log_message(self, *a):
        pass

    def _record(self, body=b""):
        FakeUpstream.seen.append(
            (self.command, self.path, self.headers.get("Authorization"), body)
        )

    def do_GET(self):
        self._record()
        if self.path in ("/status/204", "/status/304"):
            # bodiless statuses: no Content-Length, no Transfer-Encoding, no body
            self.send_response(int(self.path.rsplit("/", 1)[1]))
            self.end_headers()
            return
        if self.path == "/truncated":
            self.send_response(200)
            self.send_header("Content-Length", "100")
            self.end_headers()
            self.wfile.write(b"x" * 10)
            self.wfile.flush()
            self.close_connection = True
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(MODELS_REPLY)))
        self.end_headers()
        self.wfile.write(MODELS_REPLY)

    def do_HEAD(self):
        self._record()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()  # no Content-Length, no body

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self._record(body)
        try:
            parsed = json.loads(body)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict) and parsed.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            for i, c in enumerate(SSE_CHUNKS):
                self.wfile.write(b"%x\r\n%s\r\n" % (len(c), c))
                self.wfile.flush()
                if i == 0 and FakeUpstream.gate is not None:
                    FakeUpstream.gate.wait(10)
            self.wfile.write(b"0\r\n\r\n")
        else:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(JSON_REPLY)))
            self.end_headers()
            self.wfile.write(JSON_REPLY)


def raw_http(port, data, timeout=5):
    """Send raw bytes, return everything the server sends until it closes."""
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
        s.sendall(data)
        out = b""
        try:
            while True:
                chunk = s.recv(65536)
                if not chunk:
                    break
                out += chunk
        except socket.timeout:
            pass
        return out


class CaptureProxyTest(unittest.TestCase):
    def setUp(self):
        FakeUpstream.seen = []
        FakeUpstream.gate = None
        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstream)
        self.upstream.daemon_threads = True
        threading.Thread(target=self.upstream.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.tmp = tempfile.TemporaryDirectory()
        self.log = os.path.join(self.tmp.name, "capture.jsonl")
        self.proxy = self.start_proxy(f"http://127.0.0.1:{self.upstream.server_port}")

    def start_proxy(self, upstream_url):
        proxy = capture_proxy.make_server(0, upstream_url, self.log)
        threading.Thread(target=proxy.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.addCleanup(self._stop, proxy)
        return proxy

    @staticmethod
    def _stop(server):
        server.shutdown()
        server.server_close()

    def tearDown(self):
        if FakeUpstream.gate is not None:
            FakeUpstream.gate.set()
        self._stop(self.upstream)
        self.tmp.cleanup()

    def request(self, method, path, payload=None, headers=None, raw=None, proxy=None):
        proxy = proxy or self.proxy
        conn = http.client.HTTPConnection("127.0.0.1", proxy.server_port, timeout=5)
        body = raw if raw is not None else (None if payload is None else json.dumps(payload).encode())
        hdrs = {"Authorization": "Bearer sk-secret-key"}
        if body is not None:
            hdrs["Content-Type"] = "application/json"
        hdrs.update(headers or {})
        conn.request(method, path, body=body, headers=hdrs)
        resp = conn.getresponse()
        data = resp.read()
        status = resp.status
        conn.close()
        return status, data

    def log_lines(self):
        with open(self.log, encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def test_streaming_post_is_byte_identical_and_logged_once(self):
        payload = {"model": "m", "stream": True, "messages": [{"role": "user", "content": "hi"}]}
        status, data = self.request("POST", "/v1/chat/completions", payload)
        self.assertEqual(status, 200)
        self.assertEqual(data, SSE_BYTES)
        lines = self.log_lines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["body"], payload)
        self.assertEqual(lines[0]["method"], "POST")
        self.assertEqual(lines[0]["path"], "/v1/chat/completions")
        self.assertEqual(lines[0]["seq"], 1)
        self.assertIn("ts", lines[0])

    def test_streamed_chunk_reaches_client_before_upstream_finishes(self):
        FakeUpstream.gate = threading.Event()
        payload = {"model": "m", "stream": True}
        conn = http.client.HTTPConnection("127.0.0.1", self.proxy.server_port, timeout=5)
        conn.request("POST", "/v1/chat/completions", body=json.dumps(payload).encode(),
                     headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        # The upstream is parked on the gate after chunk 1. A proxy that buffers
        # the whole body (read() instead of read1()) never delivers it, so this
        # read times out and the test fails.
        first = resp.read1(65536)
        self.assertEqual(first, SSE_CHUNKS[0])
        FakeUpstream.gate.set()
        rest = resp.read()
        conn.close()
        self.assertEqual(first + rest, SSE_BYTES)

    def test_log_line_has_exactly_five_keys_and_no_header_value(self):
        payload = {"model": "m", "messages": []}
        status, _ = self.request("POST", "/v1/chat/completions", payload, headers=SECRETS)
        self.assertEqual(status, 200)
        for line in self.log_lines():
            self.assertEqual(set(line), {"seq", "ts", "method", "path", "body"})
        with open(self.log, encoding="utf-8") as f:
            text = f.read()
        for name, value in SECRETS.items():
            self.assertNotIn(value, text, name)
        # and the upstream still got the credential it needs
        self.assertEqual(FakeUpstream.seen[0][2], SECRETS["Authorization"])

    def test_forwards_request_unchanged(self):
        payload = {"model": "m", "stream": True, "n": 1}
        self.request("POST", "/v1/chat/completions", payload)
        method, path, auth, raw = FakeUpstream.seen[0]
        self.assertEqual((method, path), ("POST", "/v1/chat/completions"))
        self.assertEqual(auth, "Bearer sk-secret-key")
        self.assertEqual(json.loads(raw), payload)

    def test_non_streaming_post(self):
        payload = {"model": "m", "messages": []}
        status, data = self.request("POST", "/v1/chat/completions", payload)
        self.assertEqual(status, 200)
        self.assertEqual(data, JSON_REPLY)
        lines = self.log_lines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["body"], payload)

    def test_get_models(self):
        status, data = self.request("GET", "/v1/models")
        self.assertEqual(status, 200)
        self.assertEqual(data, MODELS_REPLY)
        lines = self.log_lines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["method"], "GET")
        self.assertEqual(lines[0]["path"], "/v1/models")
        self.assertIsNone(lines[0]["body"])

    def test_seq_increments(self):
        self.request("GET", "/v1/models")
        self.request("POST", "/v1/chat/completions", {"a": 1})
        self.assertEqual([l["seq"] for l in self.log_lines()], [1, 2])

    def test_concurrent_posts_get_unique_seq_and_intact_lines(self):
        n = 40
        pad = "x" * 20000
        errors = []

        def post(i):
            try:
                status, _ = self.request("POST", "/v1/chat/completions", {"i": i, "pad": pad})
                if status != 200:
                    errors.append(status)
            except Exception as e:  # noqa: BLE001
                errors.append(repr(e))

        old = sys.getswitchinterval()
        sys.setswitchinterval(1e-6)  # make an unlocked read-modify-write race show
        try:
            threads = [threading.Thread(target=post, args=(i,)) for i in range(n)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(30)
        finally:
            sys.setswitchinterval(old)
        self.assertEqual(errors, [])
        with open(self.log, encoding="utf-8") as f:
            raw_lines = [l for l in f.read().split("\n") if l]
        lines = [json.loads(l) for l in raw_lines]  # every line is intact JSON
        self.assertEqual(len(lines), n)
        self.assertEqual(sorted(l["seq"] for l in lines), list(range(1, n + 1)))
        self.assertEqual(sorted(l["body"]["i"] for l in lines), list(range(n)))

    # --- S1: surrogates and logging failures --------------------------------

    def test_lone_surrogate_body_is_forwarded_and_logged(self):
        raw = b'{"messages":[{"role":"user","content":"\\ud83d"}],"stream":false}'
        status, data = self.request("POST", "/v1/chat/completions", raw=raw)
        self.assertEqual(status, 200)
        self.assertEqual(data, JSON_REPLY)
        self.assertEqual(FakeUpstream.seen[0][3], raw)
        with open(self.log, "rb") as f:
            text = f.read()
        text.decode("ascii")  # ensure_ascii: the log is pure ASCII
        self.assertIn(b"\\ud83d", text)
        lines = self.log_lines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["seq"], 1)
        self.assertEqual(lines[0]["body"]["messages"][0]["content"], "\ud83d")

    def test_failed_write_does_not_consume_a_seq(self):
        self.proxy.log_path = self.tmp.name  # a directory: open() fails
        with self.assertRaises(OSError):
            self.proxy.record("POST", "/x", b"{}")
        self.proxy.log_path = self.log
        self.assertEqual(self.proxy.record("POST", "/x", b"{}"), 1)
        self.assertEqual([l["seq"] for l in self.log_lines()], [1])

    def test_logging_failure_is_reported_and_request_still_forwarded(self):
        self.proxy.log_path = self.tmp.name  # a directory: open() fails
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            status, data = self.request("POST", "/v1/chat/completions", {"model": "m"})
        self.assertEqual(status, 200)
        self.assertEqual(data, JSON_REPLY)
        self.assertEqual(len(FakeUpstream.seen), 1)
        self.assertIn("log write failed", err.getvalue())
        self.assertNotIn("Traceback", err.getvalue())

    def test_ts_comes_from_one_clock_read(self):
        # secs from one read and millis from another disagree across a second
        # boundary: 22:13:20.999 would be logged as 22:13:20.000.
        reads = itertools.chain([1700000000.9996], itertools.repeat(1700000001.0004))
        with mock.patch.object(capture_proxy.time, "time", side_effect=lambda: next(reads)):
            self.proxy.record("GET", "/x", b"")
        self.assertEqual(self.log_lines()[0]["ts"], "2023-11-14T22:13:20.999Z")

    # --- error paths --------------------------------------------------------

    def test_unreachable_upstream_returns_502_and_still_logs(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        dead_port = s.getsockname()[1]
        s.close()
        proxy = self.start_proxy(f"http://127.0.0.1:{dead_port}")
        status, data = self.request("POST", "/v1/chat/completions", {"model": "m"}, proxy=proxy)
        self.assertEqual(status, 502)
        self.assertIn("upstream unreachable", json.loads(data)["error"])
        self.assertEqual(len(self.log_lines()), 1)

    def test_non_json_body_is_logged_as_text_and_forwarded_unchanged(self):
        raw = b"not json \xff end"
        status, data = self.request("POST", "/v1/chat/completions", raw=raw)
        self.assertEqual(status, 200)
        self.assertEqual(FakeUpstream.seen[0][3], raw)
        body = self.log_lines()[0]["body"]
        self.assertIsInstance(body, str)
        self.assertTrue(body.startswith("not json "))

    def test_upstream_path_prefix_join(self):
        proxy = self.start_proxy(f"http://127.0.0.1:{self.upstream.server_port}/v1")
        self.request("GET", "/models", proxy=proxy)  # prefix applied
        self.request("GET", "/v1/models", proxy=proxy)  # already has it: not doubled
        self.request("GET", "/v1x/models", proxy=proxy)  # prefix match is by path segment
        self.assertEqual([p for _, p, _, _ in FakeUpstream.seen],
                         ["/v1/models", "/v1/models", "/v1/v1x/models"])

    # --- minors -------------------------------------------------------------

    def test_bad_content_length_gets_400_without_traceback(self):
        for bad in (b"abc", b"-5", b"1.5", b""):
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                out = raw_http(self.proxy.server_port,
                               b"POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\n"
                               b"Content-Length: " + bad + b"\r\n\r\n")
            self.assertTrue(out.startswith(b"HTTP/1.1 400"), (bad, out))
            self.assertNotIn("Traceback", err.getvalue(), bad)
        self.assertEqual(FakeUpstream.seen, [])

    def test_truncated_upstream_body_closes_the_client_connection(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.proxy.server_port, timeout=5)
        conn.request("GET", "/truncated")
        resp = conn.getresponse()
        # The proxy promised 100 bytes and has only 10: it must hang up so the
        # client sees a short read at once, not wait for bytes that never come.
        with self.assertRaises(http.client.IncompleteRead):
            resp.read()
        conn.close()

    def test_bodiless_responses_get_no_body_framing(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.proxy.server_port, timeout=5)
        try:
            for method, path, status in (("HEAD", "/v1/models", 200), ("GET", "/status/204", 204),
                                         ("GET", "/status/304", 304)):
                conn.request(method, path)
                resp = conn.getresponse()
                self.assertEqual(resp.status, status)
                self.assertEqual(resp.read(), b"")
                self.assertIsNone(resp.getheader("Transfer-Encoding"))
            # A stray "0\r\n\r\n" after any of those would corrupt this reply.
            conn.request("GET", "/v1/models")
            resp = conn.getresponse()
            self.assertEqual((resp.status, resp.read()), (200, MODELS_REPLY))
        finally:
            conn.close()

    def test_server_and_date_headers_are_not_duplicated(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.proxy.server_port, timeout=5)
        conn.request("GET", "/v1/models")
        resp = conn.getresponse()
        resp.read()
        names = [k.lower() for k, _ in resp.getheaders()]
        conn.close()
        self.assertEqual(names.count("server"), 1)
        self.assertEqual(names.count("date"), 1)

    def test_listen_backlog_is_large(self):
        self.assertGreaterEqual(capture_proxy.CaptureServer.request_queue_size, 128)

    def test_help_works_under_python_OO(self):
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "capture_proxy.py")
        p = subprocess.run([sys.executable, "-OO", script, "--help"], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("--upstream", p.stdout)


if __name__ == "__main__":
    unittest.main()
