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
# Header-aware variant: receives the request's headers as a plain dict (case
# -insensitive lookups still work via http.client.HTTPMessage semantics if a
# caller wants them, but a dict is enough for an Authorization presence
# check). Used by the redirect-and-strip-auth-header regression test.
HeaderAwareRouteHandler = Callable[[dict], Response]


class _Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # silence
        pass

    def do_GET(self) -> None:  # noqa: N802 (stdlib method name)
        header_handler: HeaderAwareRouteHandler | None = self.server.header_routes.get(self.path)  # type: ignore[attr-defined]
        if header_handler is not None:
            resp = header_handler(dict(self.headers.items()))
            self._send(resp)
            return
        handler: RouteHandler | None = self.server.routes.get(self.path)  # type: ignore[attr-defined]
        if handler is None:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"no route: " + self.path.encode())
            return
        resp = handler()
        self._send(resp)

    def _send(self, resp: Response) -> None:
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
        self._httpd.header_routes = {}  # type: ignore[attr-defined]
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    @property
    def routes(self) -> dict[str, RouteHandler]:
        return self._httpd.routes  # type: ignore[attr-defined]

    @property
    def header_routes(self) -> dict[str, HeaderAwareRouteHandler]:
        """Routes checked BEFORE `routes` and given the request's headers.
        Use for auth-forwarding assertions (e.g. a redirect target that must
        NOT receive an Authorization header)."""
        return self._httpd.header_routes  # type: ignore[attr-defined]

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._httpd.server_address[1]}"

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)
