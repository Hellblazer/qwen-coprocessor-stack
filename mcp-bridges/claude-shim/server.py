#!/usr/bin/env -S uv run --script
# SPDX-License-Identifier: MIT
# /// script
# requires-python = ">=3.11"
# dependencies = ["fastapi>=0.110", "uvicorn>=0.30"]
# ///
"""OpenAI-compatible HTTP shim that dispatches to a subscription-authenticated
`claude -p` subprocess.

Listens on 127.0.0.1:9000. The LiteLLM proxy (running in Docker) reaches it
via host.docker.internal:9000 and treats it as a generic OpenAI backend,
which is how `claude-escalation` route becomes subscription-billed without
needing a custom LiteLLM provider.

The subprocess inherits the host environment minus the gateway routing
vars, so the inner `claude` uses the user's normal Anthropic OAuth login.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
import uuid

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

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
TIMEOUT_SECS = int(os.environ.get("CLAUDE_TIMEOUT_SECS", "600"))

if not CLAUDE_BIN:
    raise SystemExit(
        "claude-shim: cannot find `claude` on PATH. "
        "Set CLAUDE_BIN or install Claude Code first."
    )


def _flatten(messages: list[dict]) -> str:
    """Concatenate OpenAI-format messages into one prompt string.

    `claude -p` is single-turn and has no built-in conversation memory in
    non-interactive mode, so we feed it a self-contained transcript.
    """
    chunks: list[str] = []
    for m in messages:
        role = m.get("role", "user")
        content = m.get("content", "")
        if isinstance(content, list):
            content = "\n".join(
                c.get("text", "") for c in content
                if isinstance(c, dict) and c.get("type") == "text"
            )
        if not isinstance(content, str):
            content = str(content)
        if role == "system":
            chunks.append(f"# System\n{content}")
        elif role == "assistant":
            chunks.append(f"# Assistant (prior turn)\n{content}")
        else:
            chunks.append(f"# User\n{content}")
    return "\n\n".join(chunks)


def _spawn(prompt: str) -> str:
    env = {k: v for k, v in os.environ.items() if k not in GATEWAY_ENV}
    # Use stdin for the prompt so we don't bump up against ARG_MAX on long
    # message histories.
    result = subprocess.run(
        [CLAUDE_BIN, "-p"],
        input=prompt,
        env=env,
        capture_output=True,
        text=True,
        timeout=TIMEOUT_SECS,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"claude -p exit={result.returncode}: {(result.stderr or '').strip()[:600]}"
        )
    return (result.stdout or "").strip()


class ChatRequest(BaseModel):
    model: str
    messages: list[dict]
    max_tokens: int | None = None
    temperature: float | None = None
    stream: bool = False
    # Tolerate other OpenAI fields without rejecting.
    model_config = {"extra": "allow"}


app = FastAPI(title="claude-shim")


@app.get("/v1/models")
def list_models() -> dict:
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


@app.get("/health")
@app.get("/healthz")
def health() -> dict:
    return {"status": "ok"}


def _run_or_raise(prompt: str) -> str:
    if not prompt:
        raise HTTPException(status_code=400, detail="empty prompt")
    try:
        return _spawn(prompt)
    except subprocess.TimeoutExpired:
        raise HTTPException(
            status_code=504,
            detail=f"claude -p exceeded {TIMEOUT_SECS}s",
        )
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/v1/chat/completions")
def chat(req: ChatRequest) -> dict:
    if req.stream:
        raise HTTPException(
            status_code=400,
            detail="claude-shim does not yet implement streaming responses.",
        )
    answer = _run_or_raise(_flatten(req.messages))
    now = int(time.time())
    prompt_for_count = _flatten(req.messages)
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion",
        "created": now,
        "model": req.model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": answer},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": len(prompt_for_count.split()),
            "completion_tokens": len(answer.split()),
            "total_tokens": len(prompt_for_count.split()) + len(answer.split()),
        },
    }


class MessagesRequest(BaseModel):
    """Subset of the Anthropic Messages API we accept.

    LiteLLM's `/v1/messages` pass-through forwards the original Anthropic
    request body to upstream when the upstream is openai-compat, so the shim
    needs to also speak Anthropic format directly.
    """

    model: str
    messages: list[dict]
    max_tokens: int | None = None
    system: str | list[dict] | None = None
    temperature: float | None = None
    stream: bool = False
    model_config = {"extra": "allow"}


def _flatten_anthropic(req: MessagesRequest) -> str:
    msgs: list[dict] = []
    if req.system:
        sys_text = req.system
        if isinstance(sys_text, list):
            sys_text = "\n".join(
                p.get("text", "") for p in sys_text
                if isinstance(p, dict) and p.get("type") == "text"
            )
        msgs.append({"role": "system", "content": sys_text})
    msgs.extend(req.messages)
    return _flatten(msgs)


class ResponsesRequest(BaseModel):
    """Subset of OpenAI's Responses API.

    LiteLLM's `/v1/messages -> openai/...` pass-through routes through the
    Responses adapter, which posts here rather than to chat/completions.
    """

    model: str
    input: list[dict] | str
    instructions: str | None = None
    max_output_tokens: int | None = None
    stream: bool = False
    model_config = {"extra": "allow"}


def _flatten_responses(req: ResponsesRequest) -> str:
    chunks: list[str] = []
    if req.instructions:
        chunks.append(f"# System\n{req.instructions}")
    if isinstance(req.input, str):
        chunks.append(f"# User\n{req.input}")
    else:
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
            label = {"system": "# System", "assistant": "# Assistant (prior turn)"}.get(role, "# User")
            chunks.append(f"{label}\n{content}")
    return "\n\n".join(chunks)


@app.post("/v1/responses")
def responses(req: ResponsesRequest) -> dict:
    if req.stream:
        raise HTTPException(
            status_code=400,
            detail="claude-shim does not yet implement streaming responses.",
        )
    prompt = _flatten_responses(req)
    answer = _run_or_raise(prompt)
    rid = f"resp_{uuid.uuid4().hex[:24]}"
    now = int(time.time())
    return {
        "id": rid,
        "object": "response",
        "created_at": now,
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
            "input_tokens": len(prompt.split()),
            "output_tokens": len(answer.split()),
            "total_tokens": len(prompt.split()) + len(answer.split()),
        },
    }


@app.post("/v1/messages")
def messages(req: MessagesRequest) -> dict:
    if req.stream:
        raise HTTPException(
            status_code=400,
            detail="claude-shim does not yet implement streaming responses.",
        )
    answer = _run_or_raise(_flatten_anthropic(req))
    prompt = _flatten_anthropic(req)
    return {
        "id": f"msg_{uuid.uuid4().hex[:24]}",
        "type": "message",
        "role": "assistant",
        "model": req.model,
        "content": [{"type": "text", "text": answer}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {
            "input_tokens": len(prompt.split()),
            "output_tokens": len(answer.split()),
        },
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=SHIM_PORT, log_level="info", access_log=True)
