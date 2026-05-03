#!/usr/bin/env -S uv run --script
# SPDX-License-Identifier: MIT
# /// script
# requires-python = ">=3.11"
# dependencies = ["fastapi>=0.110", "uvicorn>=0.30"]
# ///
"""OpenAI/Anthropic-compatible HTTP shim that brokers requests to a
subscription-authenticated `claude` running in stream-json mode.

Listens on 127.0.0.1:9000. The LiteLLM proxy (running in Docker) reaches
it via host.docker.internal:9000 and treats it as a generic upstream.
The shim turns each HTTP request into a single user turn fed to a
persistent stream-json `claude` process scoped to the caller's session.

Why a persistent process per session
------------------------------------
`claude -p` (one-shot, single-turn print mode) is correct but slow:
spawn cost is paid on every request, and multi-turn conversations are
flattened into a single text prompt with markdown headers — Claude has
to *infer* turn boundaries instead of seeing them natively.

Stream-json mode (--input-format stream-json --output-format stream-json)
keeps a long-lived process that consumes user messages turn-by-turn and
maintains the proper conversation structure internally. We key one
process per Claude Code session id (X-Claude-Code-Session-Id header,
falling back to a hash of the first user message). Subsequent turns
write only the *new* user message to the existing process's stdin —
Claude already has prior turns in memory.

Lifecycle
---------
- Sessions are created lazily on first request.
- A background reaper sigterms processes idle longer than
  CLAUDE_SHIM_IDLE_SECS (default 1800 = 30 min).
- On shutdown all live sessions are reaped.
- If a process dies mid-conversation, the next request creates a fresh
  one and replays the full message history (lossy for tool calls etc.,
  faithful for text).

Auth
----
Each subprocess inherits the host environment minus the gateway
routing vars, so the inner `claude` uses the user's normal OAuth
login. Subscription billing.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Config

GATEWAY_ENV = (
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
)

CLAUDE_BIN = os.environ.get("CLAUDE_BIN") or shutil.which("claude")
SHIM_PORT = int(os.environ.get("CLAUDE_SHIM_PORT", "9000"))
TURN_TIMEOUT_SECS = int(os.environ.get("CLAUDE_TURN_TIMEOUT_SECS", "600"))
SESSION_IDLE_SECS = int(os.environ.get("CLAUDE_SHIM_IDLE_SECS", "1800"))

if not CLAUDE_BIN:
    raise SystemExit(
        "claude-shim: cannot find `claude` on PATH. "
        "Set CLAUDE_BIN or install Claude Code first."
    )

logger = logging.getLogger("claude-shim")


# ---------------------------------------------------------------------------
# Session: one persistent claude process

class ClaudeSession:
    """One stream-json claude process bound to a single conversation."""

    def __init__(self, session_key: str) -> None:
        self.session_key = session_key
        self.claude_uuid = str(uuid.uuid4())
        self.proc: asyncio.subprocess.Process | None = None
        self.lock = asyncio.Lock()
        self.last_activity = time.monotonic()
        # turns_seen counts user turns we have already submitted to claude
        self.turns_seen = 0
        self._stderr_drain_task: asyncio.Task | None = None

    async def start(self) -> None:
        env = {k: v for k, v in os.environ.items() if k not in GATEWAY_ENV}
        # `--tools ""` disables built-in tools so claude answers as an oracle
        # rather than spawning a Bash/Edit loop in the gateway's cwd.
        # `--no-session-persistence` keeps state in-memory only.
        self.proc = await asyncio.create_subprocess_exec(
            CLAUDE_BIN,
            "-p",
            "--verbose",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--session-id", self.claude_uuid,
            "--no-session-persistence",
            "--tools", "",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        # Drain stderr in the background to prevent the pipe from filling and
        # blocking the subprocess. Errors land in our log only.
        self._stderr_drain_task = asyncio.create_task(self._drain_stderr())
        logger.info("session started key=%s claude=%s", self.session_key[:24], self.claude_uuid[:8])

    async def _drain_stderr(self) -> None:
        assert self.proc is not None and self.proc.stderr is not None
        try:
            while True:
                line = await self.proc.stderr.readline()
                if not line:
                    return
                logger.warning("claude stderr [%s]: %s", self.session_key[:16], line.decode(errors="replace").rstrip())
        except Exception:
            return

    def alive(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    async def submit_one(self, user_text: str) -> str:
        """Send one user turn over stdin and read until result. Returns assistant text."""
        if not self.alive():
            raise RuntimeError("session process is not alive")
        assert self.proc is not None and self.proc.stdin is not None and self.proc.stdout is not None

        msg = {
            "type": "user",
            "message": {"role": "user", "content": [{"type": "text", "text": user_text}]},
        }
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())
        await self.proc.stdin.drain()

        deadline = asyncio.get_event_loop().time() + TURN_TIMEOUT_SECS
        chunks: list[str] = []
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                raise asyncio.TimeoutError("turn exceeded timeout")
            try:
                line = await asyncio.wait_for(self.proc.stdout.readline(), timeout=remaining)
            except asyncio.TimeoutError:
                raise
            if not line:
                raise RuntimeError("unexpected EOF from claude stdout")
            try:
                event = json.loads(line.decode())
            except json.JSONDecodeError:
                continue

            t = event.get("type")
            if t == "assistant":
                for c in event.get("message", {}).get("content", []):
                    if c.get("type") == "text":
                        chunks.append(c.get("text", ""))
            elif t == "result":
                self.last_activity = time.monotonic()
                self.turns_seen += 1
                if event.get("subtype") == "success":
                    return "".join(chunks)
                raise RuntimeError(
                    f"claude result subtype={event.get('subtype')} "
                    f"error={event.get('error', '')}"
                )
            # All other event types (system/init, stream_event, rate_limit, etc.)
            # are informational — we just keep reading.

    async def submit_turns(self, user_texts: list[str]) -> str:
        """Replay multiple user turns; return the LAST turn's assistant text."""
        last = ""
        for txt in user_texts:
            last = await self.submit_one(txt)
        return last

    async def close(self) -> None:
        if self.proc is None:
            return
        if self.proc.returncode is None:
            try:
                if self.proc.stdin is not None:
                    self.proc.stdin.close()
                await asyncio.wait_for(self.proc.wait(), timeout=5)
            except (asyncio.TimeoutError, ProcessLookupError):
                try:
                    self.proc.kill()
                    await self.proc.wait()
                except ProcessLookupError:
                    pass
        if self._stderr_drain_task and not self._stderr_drain_task.done():
            self._stderr_drain_task.cancel()
        logger.info("session closed key=%s turns=%d", self.session_key[:24], self.turns_seen)


# ---------------------------------------------------------------------------
# Manager: a dict of sessions plus an idle reaper

class SessionManager:
    def __init__(self) -> None:
        self.sessions: dict[str, ClaudeSession] = {}
        self.dict_lock = asyncio.Lock()

    async def get_or_create(self, key: str) -> ClaudeSession:
        async with self.dict_lock:
            existing = self.sessions.get(key)
            if existing is not None and existing.alive():
                return existing
            if existing is not None:
                # Dead — drop it before creating a fresh one
                logger.info("replacing dead session key=%s", key[:24])
                await existing.close()
                self.sessions.pop(key, None)
            session = ClaudeSession(key)
            await session.start()
            self.sessions[key] = session
            return session

    async def reap_idle(self) -> None:
        while True:
            await asyncio.sleep(60)
            now = time.monotonic()
            stale: list[ClaudeSession] = []
            async with self.dict_lock:
                for k, s in list(self.sessions.items()):
                    if not s.alive() or (now - s.last_activity) > SESSION_IDLE_SECS:
                        stale.append(s)
                        del self.sessions[k]
            for s in stale:
                await s.close()

    async def shutdown(self) -> None:
        async with self.dict_lock:
            sessions = list(self.sessions.values())
            self.sessions.clear()
        for s in sessions:
            await s.close()


# ---------------------------------------------------------------------------
# Request handling

def _extract_user_texts(messages: list[dict]) -> list[str]:
    """Collect all user-role messages as plain text, in order."""
    out: list[str] = []
    for m in messages:
        if m.get("role") != "user":
            continue
        content = m.get("content", "")
        if isinstance(content, list):
            content = "\n".join(
                c.get("text", "") for c in content
                if isinstance(c, dict) and c.get("type") in ("text", "input_text")
            )
        if not isinstance(content, str):
            content = str(content)
        if content.strip():
            out.append(content)
    return out


def _system_text(messages: list[dict]) -> str:
    """Concat system messages, if any."""
    out: list[str] = []
    for m in messages:
        if m.get("role") != "system":
            continue
        content = m.get("content", "")
        if isinstance(content, list):
            content = "\n".join(
                c.get("text", "") for c in content
                if isinstance(c, dict) and c.get("type") in ("text", "input_text")
            )
        if not isinstance(content, str):
            content = str(content)
        if content.strip():
            out.append(content)
    return "\n\n".join(out)


def _session_key(headers: dict[str, str], messages: list[dict]) -> str:
    """Stable identifier for the conversation.

    Prefer the X-Claude-Code-Session-Id header (Claude Code emits it on every
    request). Fall back to a hash of the first user message — different
    conversations almost certainly have different first turns.
    """
    for h in ("x-claude-code-session-id", "x-anthropic-session-id"):
        v = headers.get(h)
        if v:
            return f"hdr:{v}"
    user_texts = _extract_user_texts(messages)
    if user_texts:
        digest = hashlib.sha256(user_texts[0].encode("utf-8")).hexdigest()[:24]
        return f"first:{digest}"
    return f"anon:{uuid.uuid4()}"


async def _handle_turn(
    request: Request,
    messages: list[dict],
    system: str | None = None,
) -> tuple[str, str]:
    """Submit the new turn(s) for this conversation and return (assistant_text, session_key)."""
    if not messages:
        raise HTTPException(status_code=400, detail="empty messages")

    user_texts = _extract_user_texts(messages)
    if not user_texts:
        raise HTTPException(status_code=400, detail="no user messages")

    session_key = _session_key({k.lower(): v for k, v in request.headers.items()}, messages)
    manager: SessionManager = request.app.state.manager
    session = await manager.get_or_create(session_key)

    async with session.lock:
        # If we have a system prompt and this is the very first turn for this
        # session, prepend it to the first user message so claude sees it.
        if session.turns_seen == 0 and system:
            user_texts = [f"# System\n{system}\n\n# User\n{user_texts[0]}"] + user_texts[1:]

        new_count = len(user_texts) - session.turns_seen
        if new_count <= 0:
            raise HTTPException(
                status_code=400,
                detail=f"no new user turns (history has {len(user_texts)}, session already saw {session.turns_seen})",
            )
        new_turns = user_texts[session.turns_seen:]

        try:
            answer = await session.submit_turns(new_turns)
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail=f"turn exceeded {TURN_TIMEOUT_SECS}s")
        except RuntimeError as e:
            # Subprocess died or returned an error. Drop the session so the
            # next request starts fresh.
            await session.close()
            async with manager.dict_lock:
                manager.sessions.pop(session_key, None)
            raise HTTPException(status_code=502, detail=str(e))

        return answer, session_key


# ---------------------------------------------------------------------------
# FastAPI app

@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    manager = SessionManager()
    app.state.manager = manager
    reap_task = asyncio.create_task(manager.reap_idle())
    try:
        yield
    finally:
        reap_task.cancel()
        try:
            await reap_task
        except asyncio.CancelledError:
            pass
        await manager.shutdown()


app = FastAPI(title="claude-shim", lifespan=lifespan)


@app.get("/health")
@app.get("/healthz")
async def health() -> dict:
    manager: SessionManager = app.state.manager
    return {"status": "ok", "sessions": len(manager.sessions)}


@app.get("/v1/models")
async def list_models() -> dict:
    return {
        "object": "list",
        "data": [
            {
                "id": "claude-pro",
                "object": "model",
                "created": int(time.time()),
                "owned_by": "subscription",
            }
        ],
    }


# --- /v1/chat/completions (OpenAI Chat) ---

class ChatRequest(BaseModel):
    model: str
    messages: list[dict]
    max_tokens: int | None = None
    temperature: float | None = None
    stream: bool = False
    model_config = {"extra": "allow"}


@app.post("/v1/chat/completions")
async def chat(req: ChatRequest, request: Request) -> dict:
    if req.stream:
        raise HTTPException(status_code=400, detail="streaming not yet implemented")
    sys_text = _system_text(req.messages)
    answer, _ = await _handle_turn(request, req.messages, system=sys_text or None)
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": req.model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": answer},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": len(answer.split()),
            "total_tokens": len(answer.split()),
        },
    }


# --- /v1/messages (Anthropic Messages) ---

class MessagesRequest(BaseModel):
    model: str
    messages: list[dict]
    max_tokens: int | None = None
    system: str | list[dict] | None = None
    temperature: float | None = None
    stream: bool = False
    model_config = {"extra": "allow"}


def _anthropic_system_text(req: MessagesRequest) -> str | None:
    if req.system is None:
        return None
    if isinstance(req.system, str):
        return req.system
    return "\n".join(
        p.get("text", "") for p in req.system
        if isinstance(p, dict) and p.get("type") == "text"
    )


@app.post("/v1/messages")
async def messages(req: MessagesRequest, request: Request) -> dict:
    if req.stream:
        raise HTTPException(status_code=400, detail="streaming not yet implemented")
    answer, _ = await _handle_turn(request, req.messages, system=_anthropic_system_text(req))
    return {
        "id": f"msg_{uuid.uuid4().hex[:24]}",
        "type": "message",
        "role": "assistant",
        "model": req.model,
        "content": [{"type": "text", "text": answer}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {
            "input_tokens": 0,
            "output_tokens": len(answer.split()),
        },
    }


# --- /v1/responses (OpenAI Responses) ---

class ResponsesRequest(BaseModel):
    model: str
    input: list[dict] | str
    instructions: str | None = None
    max_output_tokens: int | None = None
    stream: bool = False
    model_config = {"extra": "allow"}


def _responses_to_messages(req: ResponsesRequest) -> list[dict]:
    """Map the Responses API `input` field into OpenAI-style messages so the
    same _handle_turn machinery applies."""
    out: list[dict] = []
    if isinstance(req.input, str):
        out.append({"role": "user", "content": req.input})
        return out
    for item in req.input:
        role = item.get("role", "user")
        content = item.get("content", "")
        if isinstance(content, list):
            content = "\n".join(
                p.get("text", "") for p in content
                if isinstance(p, dict)
                and p.get("type") in ("input_text", "output_text", "text")
            )
        if not isinstance(content, str):
            content = str(content)
        out.append({"role": role, "content": content})
    return out


@app.post("/v1/responses")
async def responses(req: ResponsesRequest, request: Request) -> dict:
    if req.stream:
        raise HTTPException(status_code=400, detail="streaming not yet implemented")
    msgs = _responses_to_messages(req)
    answer, _ = await _handle_turn(request, msgs, system=req.instructions)
    return {
        "id": f"resp_{uuid.uuid4().hex[:24]}",
        "object": "response",
        "created_at": int(time.time()),
        "model": req.model,
        "status": "completed",
        "output": [
            {
                "type": "message",
                "id": f"msg_{uuid.uuid4().hex[:24]}",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": answer, "annotations": []}],
            }
        ],
        "usage": {
            "input_tokens": 0,
            "output_tokens": len(answer.split()),
            "total_tokens": len(answer.split()),
        },
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=SHIM_PORT, log_level="info", access_log=True)
