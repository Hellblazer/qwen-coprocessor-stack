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
from fastapi.responses import StreamingResponse
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

# Pass --model explicitly so the inner claude doesn't inherit a saved default
# from ~/.claude.json — which can easily be a gateway route name (e.g.
# "claude-escalation") that's meaningless outside the gateway and causes
# every subprocess to error out with "selected model may not exist".
# Override with CLAUDE_MODEL=opus to use Opus, or a full model id.
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "sonnet")

# Spawn the inner claude in a neutral working directory so it doesn't
# auto-discover CLAUDE.md / git status from wherever the gateway happens to
# live. Created on import; OK to share across sessions (claude only reads).
CLAUDE_CWD = os.environ.get("CLAUDE_SHIM_CWD") or "/tmp/claude-shim-cwd"
os.makedirs(CLAUDE_CWD, exist_ok=True)

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
        # cwd=CLAUDE_CWD points the inner claude at a neutral directory so it
        # doesn't auto-pick-up CLAUDE.md / git status from the gateway repo.
        self.proc = await asyncio.create_subprocess_exec(
            CLAUDE_BIN,
            "-p",
            "--verbose",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--session-id", self.claude_uuid,
            "--model", CLAUDE_MODEL,
            "--no-session-persistence",
            "--include-partial-messages",
            "--tools", "",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=CLAUDE_CWD,
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

    async def stream_turn(self, user_text: str):
        """Submit one user turn and yield text deltas as they arrive.

        Yields plain str chunks. The caller is responsible for wrapping each
        chunk in whatever SSE shape the client protocol requires. After the
        last delta the generator returns; on error it raises.
        """
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
            if t == "stream_event":
                inner = event.get("event", {})
                if inner.get("type") == "content_block_delta":
                    delta = inner.get("delta", {})
                    if delta.get("type") == "text_delta":
                        text = delta.get("text", "")
                        if text:
                            yield text
            elif t == "result":
                self.last_activity = time.monotonic()
                self.turns_seen += 1
                if event.get("subtype") == "success":
                    return
                raise RuntimeError(
                    f"claude result subtype={event.get('subtype')} "
                    f"error={event.get('error', '')}"
                )

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


def _extract_text(content: Any) -> str:
    """Pull plain text out of an OpenAI/Anthropic-shaped content field."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            c.get("text", "") for c in content
            if isinstance(c, dict) and c.get("type") in ("text", "input_text", "output_text")
        )
    return str(content) if content else ""


def _build_seed_for_history(
    messages: list[dict], system: str | None
) -> str | None:
    """Build a single user-message seed that faithfully replays a prior
    conversation. Returns None if there is no history to replay (i.e. only
    one user message).

    Used when a session arrives fresh on a multi-turn conversation — either
    because the user pinned `claude-escalation` mid-conversation, or because
    a prior session process died and we're recreating it.

    Stream-json input only accepts user messages, so the only way to inject
    prior assistant turns into the inner Claude's context is to quote them
    inside a user message. Lossy for prior tool calls, faithful for text.
    """
    user_idx = [i for i, m in enumerate(messages) if m.get("role") == "user"]
    if len(user_idx) < 1:
        return None
    last_user_pos = user_idx[-1]
    history = messages[:last_user_pos]
    last_user = _extract_text(messages[last_user_pos].get("content", ""))
    if not history and not system:
        # Truly fresh first turn — no replay needed.
        return None

    parts: list[str] = []
    parts.append(
        "You are continuing a conversation that started elsewhere. "
        "What follows is the prior exchange transcribed for context, "
        "then the new user message you should respond to."
    )
    if system:
        parts.append(f"## System instructions in effect\n{system.strip()}")
    if history:
        lines: list[str] = []
        for m in history:
            role = m.get("role")
            text = _extract_text(m.get("content", "")).strip()
            if not text:
                continue
            if role == "system":
                lines.append(f"### System\n{text}")
            elif role == "assistant":
                lines.append(f"### Assistant (prior turn)\n{text}")
            elif role == "user":
                lines.append(f"### User (prior turn)\n{text}")
        if lines:
            parts.append("## Prior exchange\n\n" + "\n\n".join(lines))
    parts.append(f"## New user message — answer this\n{last_user.strip()}")
    return "\n\n".join(parts)


async def _resolve_prompt_for_session(
    session: "ClaudeSession",
    messages: list[dict],
    system: str | None,
    user_texts: list[str],
) -> str:
    """Prepare the *single* prompt to submit for this turn.

    Submits any history-replay or seed turns synchronously so the caller can
    stream just one final response. Must be called while holding session.lock.
    """
    if session.turns_seen == 0:
        seed = _build_seed_for_history(messages, system)
        if seed is not None:
            return seed
        first = user_texts[0]
        if system:
            first = f"# System\n{system}\n\n# User\n{first}"
        return first
    new_turns = user_texts[session.turns_seen:]
    if not new_turns:
        raise HTTPException(
            status_code=400,
            detail=f"no new user turns (history has {len(user_texts)}, "
                   f"session already saw {session.turns_seen})",
        )
    # Submit any earlier-but-still-new turns synchronously; only stream the last.
    for earlier in new_turns[:-1]:
        await session.submit_one(earlier)
    return new_turns[-1]


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
        try:
            if session.turns_seen == 0:
                # First turn for this session. Either the conversation is
                # genuinely starting now, or it began elsewhere and the
                # client has handed us a multi-turn history (mid-conversation
                # pin or crash recovery).
                seed = _build_seed_for_history(messages, system)
                if seed is not None:
                    answer = await session.submit_one(seed)
                else:
                    # Single user turn, no prior history.
                    first = user_texts[0]
                    if system:
                        first = f"# System\n{system}\n\n# User\n{first}"
                    answer = await session.submit_one(first)
            else:
                # Continuation — submit only any new user turns since last call.
                new_turns = user_texts[session.turns_seen:]
                if not new_turns:
                    raise HTTPException(
                        status_code=400,
                        detail=f"no new user turns (history has {len(user_texts)}, session already saw {session.turns_seen})",
                    )
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


def _sse(event_name: str, data: dict) -> str:
    """Format an SSE record."""
    return f"event: {event_name}\ndata: {json.dumps(data)}\n\n"


async def _stream_anthropic_messages(
    req: "MessagesRequest", request: Request
):
    """Async generator emitting Anthropic Messages SSE events."""
    msg_id = f"msg_{uuid.uuid4().hex[:24]}"
    user_texts = _extract_user_texts(req.messages)
    if not user_texts:
        yield _sse(
            "error",
            {"type": "error", "error": {"type": "invalid_request_error", "message": "no user messages"}},
        )
        return

    session_key = _session_key(
        {k.lower(): v for k, v in request.headers.items()}, req.messages
    )
    manager: SessionManager = request.app.state.manager
    session = await manager.get_or_create(session_key)
    system = _anthropic_system_text(req)

    async with session.lock:
        try:
            prompt = await _resolve_prompt_for_session(session, req.messages, system, user_texts)
        except HTTPException as e:
            yield _sse(
                "error",
                {"type": "error", "error": {"type": "invalid_request_error", "message": e.detail}},
            )
            return

        yield _sse("message_start", {
            "type": "message_start",
            "message": {
                "id": msg_id,
                "type": "message",
                "role": "assistant",
                "model": req.model,
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 0, "output_tokens": 0},
            },
        })
        yield _sse("content_block_start", {
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "text", "text": ""},
        })

        output_tokens = 0
        try:
            async for chunk in session.stream_turn(prompt):
                if not chunk:
                    continue
                output_tokens += len(chunk.split())
                yield _sse("content_block_delta", {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": chunk},
                })
        except (asyncio.TimeoutError, RuntimeError) as e:
            # Tear the session down — next request will recreate it.
            await session.close()
            async with manager.dict_lock:
                manager.sessions.pop(session_key, None)
            yield _sse(
                "error",
                {"type": "error", "error": {"type": "api_error", "message": str(e)}},
            )
            return

        yield _sse("content_block_stop", {"type": "content_block_stop", "index": 0})
        yield _sse("message_delta", {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn", "stop_sequence": None},
            "usage": {"output_tokens": output_tokens},
        })
        yield _sse("message_stop", {"type": "message_stop"})


@app.post("/v1/messages")
async def messages(req: MessagesRequest, request: Request):
    if req.stream:
        return StreamingResponse(
            _stream_anthropic_messages(req, request),
            media_type="text/event-stream",
        )
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


async def _stream_openai_responses(
    req: "ResponsesRequest", request: Request
):
    """Async generator emitting OpenAI Responses API SSE events."""
    rid = f"resp_{uuid.uuid4().hex[:24]}"
    item_id = f"msg_{uuid.uuid4().hex[:24]}"
    msgs = _responses_to_messages(req)
    user_texts = _extract_user_texts(msgs)
    if not user_texts:
        yield _sse("error", {"error": {"message": "no user messages"}})
        return

    session_key = _session_key(
        {k.lower(): v for k, v in request.headers.items()}, msgs
    )
    manager: SessionManager = request.app.state.manager
    session = await manager.get_or_create(session_key)

    async with session.lock:
        try:
            prompt = await _resolve_prompt_for_session(
                session, msgs, req.instructions, user_texts
            )
        except HTTPException as e:
            yield _sse("error", {"error": {"message": e.detail}})
            return

        created = int(time.time())

        # response.created
        yield _sse("response.created", {
            "type": "response.created",
            "response": {
                "id": rid, "object": "response", "created_at": created,
                "model": req.model, "status": "in_progress", "output": [],
            },
        })
        # response.output_item.added (the message)
        yield _sse("response.output_item.added", {
            "type": "response.output_item.added",
            "output_index": 0,
            "item": {
                "type": "message", "id": item_id, "status": "in_progress",
                "role": "assistant", "content": [],
            },
        })
        # response.content_part.added (the output_text part)
        yield _sse("response.content_part.added", {
            "type": "response.content_part.added",
            "item_id": item_id, "output_index": 0, "content_index": 0,
            "part": {"type": "output_text", "text": "", "annotations": []},
        })

        accumulated: list[str] = []
        try:
            async for chunk in session.stream_turn(prompt):
                if not chunk:
                    continue
                accumulated.append(chunk)
                yield _sse("response.output_text.delta", {
                    "type": "response.output_text.delta",
                    "item_id": item_id, "output_index": 0, "content_index": 0,
                    "delta": chunk,
                })
        except (asyncio.TimeoutError, RuntimeError) as e:
            await session.close()
            async with manager.dict_lock:
                manager.sessions.pop(session_key, None)
            yield _sse("error", {"error": {"message": str(e)}})
            return

        full_text = "".join(accumulated)
        # response.output_text.done
        yield _sse("response.output_text.done", {
            "type": "response.output_text.done",
            "item_id": item_id, "output_index": 0, "content_index": 0,
            "text": full_text,
        })
        yield _sse("response.content_part.done", {
            "type": "response.content_part.done",
            "item_id": item_id, "output_index": 0, "content_index": 0,
            "part": {"type": "output_text", "text": full_text, "annotations": []},
        })
        yield _sse("response.output_item.done", {
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {
                "type": "message", "id": item_id, "status": "completed",
                "role": "assistant",
                "content": [{"type": "output_text", "text": full_text, "annotations": []}],
            },
        })
        out_tokens = len(full_text.split())
        yield _sse("response.completed", {
            "type": "response.completed",
            "response": {
                "id": rid, "object": "response", "created_at": created,
                "model": req.model, "status": "completed",
                "output": [{
                    "type": "message", "id": item_id, "status": "completed",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": full_text, "annotations": []}],
                }],
                "usage": {
                    "input_tokens": 0, "output_tokens": out_tokens,
                    "total_tokens": out_tokens,
                },
            },
        })


@app.post("/v1/responses")
async def responses(req: ResponsesRequest, request: Request):
    if req.stream:
        return StreamingResponse(
            _stream_openai_responses(req, request),
            media_type="text/event-stream",
        )
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
