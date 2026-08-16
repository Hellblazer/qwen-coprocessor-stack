# SPDX-License-Identifier: MIT
"""Minimal real-HTTP fake origin server for provenance tests.

No urllib mocking: this spins up a real `http.server.ThreadingHTTPServer`
on 127.0.0.1:0 and serves routes registered by exact request path (path +
query string, i.e. `self.path` as the stdlib handler sees it). Tests point
`provenance.py` at it via `--hf-base` / `--gh-base`.
"""

from __future__ import annotations

import http.server
import threading
from dataclasses import dataclass, field
from typing import Callable


@dataclass
class Response:
    status: int = 200
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""


RouteHandler = Callable[[], Response]


class _Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # silence
        pass

    def do_GET(self) -> None:  # noqa: N802 (stdlib method name)
        handler: RouteHandler | None = self.server.routes.get(self.path)  # type: ignore[attr-defined]
        if handler is None:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"no route: " + self.path.encode())
            return
        resp = handler()
        self.send_response(resp.status)
        for k, v in resp.headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(resp.body)))
        self.end_headers()
        self.wfile.write(resp.body)


class FakeServer:
    """A real HTTP server on an OS-assigned port, with a path->Response route table."""

    def __init__(self) -> None:
        self._httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self._httpd.routes = {}  # type: ignore[attr-defined]
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    @property
    def routes(self) -> dict[str, RouteHandler]:
        return self._httpd.routes  # type: ignore[attr-defined]

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._httpd.server_address[1]}"

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)
