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

log = logging.getLogger("qwen-router")

try:
    from litellm.integrations.custom_logger import CustomLogger
except ImportError:  # litellm absent — heuristic is still importable for tests.
    CustomLogger = object  # type: ignore[assignment,misc]

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


# --------------------------------------------------------------------------- #
# Self-tests. Run via `python /app/router.py` inside the LiteLLM container,   #
# or `python config/router.py` host-side if litellm is installed locally.     #
# --------------------------------------------------------------------------- #
def _selftest() -> int:
    cases: list[tuple[str, list[dict[str, Any]], dict[str, str], str]] = [
        (
            "trivial -> local",
            [{"role": "user", "content": "fix this typo"}],
            {"ANTHROPIC_API_KEY": "sk-ant-real"},
            LOCAL_ROUTE,
        ),
        (
            "medium -> remote",
            [{"role": "user", "content": "word " * 1700}],
            {"ANTHROPIC_API_KEY": "sk-ant-real"},
            REMOTE_ROUTE,
        ),
        (
            "huge -> escalation",
            [{"role": "user", "content": "word " * 7000}],
            {"ANTHROPIC_API_KEY": "sk-ant-real"},
            ESCALATION_ROUTE,
        ),
        (
            "keyword -> escalation",
            [{"role": "user", "content": "please prove the invariant holds"}],
            {"ANTHROPIC_API_KEY": "sk-ant-real",
             "ROUTER_HARD_KEYWORDS": "prove,architect"},
            ESCALATION_ROUTE,
        ),
        (
            "no anthropic key collapses keyword to local",
            [{"role": "user", "content": "please prove the invariant holds"}],
            {"ANTHROPIC_API_KEY": "",
             "ROUTER_HARD_KEYWORDS": "prove,architect"},
            LOCAL_ROUTE,
        ),
        (
            "no anthropic key collapses huge to remote",
            [{"role": "user", "content": "word " * 7000}],
            {"ANTHROPIC_API_KEY": ""},
            REMOTE_ROUTE,
        ),
    ]

    fails = 0
    for name, messages, env, expected in cases:
        # Snapshot + apply scoped env.
        saved = {k: os.environ.get(k) for k in env}
        for k, v in env.items():
            if v == "" and k in os.environ:
                del os.environ[k]
            else:
                os.environ[k] = v
        try:
            got = pick_target(messages)
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        ok = got == expected
        fails += 0 if ok else 1
        print(f"  [{'+' if ok else '!'}] {name}: got={got} expected={expected}")
    print(f"\n{'PASS' if fails == 0 else f'FAIL ({fails})'} — router heuristic")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    import sys
    sys.exit(_selftest())
