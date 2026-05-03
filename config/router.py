# SPDX-License-Identifier: MIT
"""Custom LiteLLM pre-call hook implementing the qwen-coprocessor routing policy.

Policy (in order):
  1. If the user message contains any ROUTER_HARD_KEYWORDS  -> claude-escalation
  2. If approx-token count >= ROUTER_LARGE_PROMPT_TOKENS    -> claude-escalation
  3. If approx-token count >= ROUTER_REMOTE_THRESHOLD_TOKENS -> claude-qwen-remote
  4. Otherwise                                              -> claude-qwen-coding

The hook only rewrites requests whose `model` is the meta-route
`claude-router-auto`. Explicit model selections (e.g. via Claude Code's
/model picker) pass through untouched.

LiteLLM's normal fallback chain (configured in litellm_config.yaml) handles
the case where the chosen route is unreachable — e.g. claude-qwen-remote
returning a connection error falls back to claude-qwen-coding, which falls
back to claude-escalation if Anthropic credentials are present.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from litellm.integrations.custom_logger import CustomLogger

log = logging.getLogger("qwen-router")

META_ROUTE = "claude-router-auto"
LOCAL_ROUTE = "claude-qwen-coding"
REMOTE_ROUTE = "claude-qwen-remote"
ESCALATION_ROUTE = "claude-escalation"


def _approx_tokens(messages: list[dict[str, Any]]) -> int:
    """Rough token estimate. ~1.3 tokens per whitespace-separated word."""
    total_words = 0
    for m in messages:
        content = m.get("content")
        if isinstance(content, str):
            total_words += len(content.split())
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and isinstance(part.get("text"), str):
                    total_words += len(part["text"].split())
    return int(total_words * 1.3)


def _user_text(messages: list[dict[str, Any]]) -> str:
    chunks: list[str] = []
    for m in messages:
        if m.get("role") != "user":
            continue
        content = m.get("content")
        if isinstance(content, str):
            chunks.append(content)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and isinstance(part.get("text"), str):
                    chunks.append(part["text"])
    return " ".join(chunks).lower()


def _hard_keywords() -> list[str]:
    raw = os.environ.get("ROUTER_HARD_KEYWORDS", "")
    return [kw.strip().lower() for kw in raw.split(",") if kw.strip()]


def _has_anthropic_key() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def pick_target(messages: list[dict[str, Any]]) -> str:
    text = _user_text(messages)
    tokens = _approx_tokens(messages)

    if _has_anthropic_key():
        for kw in _hard_keywords():
            if kw and kw in text:
                log.info("route=escalation reason=keyword=%r tokens=%d", kw, tokens)
                return ESCALATION_ROUTE

        large = int(os.environ.get("ROUTER_LARGE_PROMPT_TOKENS", "8000"))
        if tokens >= large:
            log.info("route=escalation reason=large_prompt tokens=%d", tokens)
            return ESCALATION_ROUTE

    remote_threshold = int(os.environ.get("ROUTER_REMOTE_THRESHOLD_TOKENS", "2000"))
    if tokens >= remote_threshold:
        log.info("route=remote reason=size tokens=%d", tokens)
        return REMOTE_ROUTE

    log.info("route=local tokens=%d", tokens)
    return LOCAL_ROUTE


class RouterCallback(CustomLogger):
    """Mutates `data["model"]` for meta-route requests before dispatch."""

    async def async_pre_call_hook(  # noqa: D401 — LiteLLM contract
        self,
        user_api_key_dict: Any,
        cache: Any,
        data: dict[str, Any],
        call_type: str,
    ) -> dict[str, Any]:
        model = data.get("model")
        if model != META_ROUTE:
            return data

        messages = data.get("messages") or []
        target = pick_target(messages)
        data["model"] = target
        log.info("rewrote %s -> %s (call_type=%s)", META_ROUTE, target, call_type)
        return data


router_callback_instance = RouterCallback()
