"""Tests for capture_proxy (bead gj36.1.2). Stdlib only, offline, port 0."""
import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

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


class FakeUpstream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    seen = []  # (method, path, auth header, raw body)

    def log_message(self, *a):
        pass

    def _record(self, body=b""):
        FakeUpstream.seen.append(
            (self.command, self.path, self.headers.get("Authorization"), body)
        )

    def do_GET(self):
        self._record()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(MODELS_REPLY)))
        self.end_headers()
        self.wfile.write(MODELS_REPLY)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self._record(body)
        if json.loads(body).get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            for c in SSE_CHUNKS:
                self.wfile.write(b"%x\r\n%s\r\n" % (len(c), c))
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        else:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(JSON_REPLY)))
            self.end_headers()
            self.wfile.write(JSON_REPLY)


class CaptureProxyTest(unittest.TestCase):
    def setUp(self):
        FakeUpstream.seen = []
        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstream)
        self.upstream.daemon_threads = True
        threading.Thread(target=self.upstream.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.tmp = tempfile.TemporaryDirectory()
        self.log = os.path.join(self.tmp.name, "capture.jsonl")
        self.proxy = capture_proxy.make_server(
            0, f"http://127.0.0.1:{self.upstream.server_port}", self.log
        )
        threading.Thread(target=self.proxy.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()

    def tearDown(self):
        for s in (self.proxy, self.upstream):
            s.shutdown()
            s.server_close()
        self.tmp.cleanup()

    def request(self, method, path, payload=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.proxy.server_port, timeout=5)
        body = None if payload is None else json.dumps(payload).encode()
        headers = {"Authorization": "Bearer sk-secret-key"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=body, headers=headers)
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
        self.assertNotIn("authorization", json.dumps(lines[0]).lower())
        with open(self.log, encoding="utf-8") as f:
            self.assertNotIn("sk-secret-key", f.read())

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


if __name__ == "__main__":
    unittest.main()
