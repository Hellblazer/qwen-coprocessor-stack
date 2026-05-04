#!/usr/bin/env -S uv run --script
# SPDX-License-Identifier: MIT
# /// script
# requires-python = ">=3.11"
# dependencies = ["mcp>=1.0.0", "httpx>=0.27"]
# ///
"""MCP bridge that exposes a local Qwen 3.6-27B (running under llama-server on
the M4 Max) to Claude Code as a set of *coprocessor* tools.

The orchestration model
-----------------------
Claude Code runs normally — subscription auth, full TUI, default model picker.
This MCP server lives at user-scope, so Claude sees the tools below as part
of its toolbox alongside Bash, Read, Edit, etc. Claude decides per-turn
whether to delegate to Qwen.

Each tool is shaped to make a particular *kind* of delegation obvious:
  - qwen()           : general escape hatch for cheap text work
  - qwen_classify()  : pick one of N labels (triage / routing)
  - qwen_summarize() : compress text to save Claude's context budget
  - qwen_extract()   : structured data out of prose

Why a tool surface and not one bare "ask Qwen anything" tool? Bare tools give
the model no scaffolding for *when* to invoke them. Shaped tools teach Claude
the delegation pattern through their docstrings.

Backend
-------
Talks to llama-server's OpenAI-compatible /v1/chat/completions on
QWEN_BASE_URL (default http://localhost:8080/v1). Default model alias
QWEN_MODEL=qwen3.6-27b-instruct matches what scripts/start-stack.sh
passes via --alias to llama-server.

Auth
----
None. Local only, listens on loopback only.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

QWEN_BASE_URL = os.environ.get("QWEN_BASE_URL", "http://localhost:8080/v1")
QWEN_MODEL = os.environ.get("QWEN_MODEL", "qwen3.6-27b-instruct")
QWEN_TIMEOUT_SECS = float(os.environ.get("QWEN_TIMEOUT_SECS", "180"))

# Qwen 3.6-27B is hybrid-thinking; default to no-think for coprocessor work
# (fast, terse). Tools that benefit from reasoning expose a `deep` knob.
DEFAULT_NO_THINK = {"chat_template_kwargs": {"enable_thinking": False}}
DEEP_THINK = {"chat_template_kwargs": {"enable_thinking": True}}


mcp = FastMCP("qwen-coprocessor")


def _call_qwen(
    messages: list[dict],
    *,
    deep: bool = False,
    max_tokens: int = 2048,
    temperature: float = 0.6,
) -> str:
    """POST to llama-server /v1/chat/completions and return the assistant text."""
    body: dict[str, Any] = {
        "model": QWEN_MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "extra_body": DEEP_THINK if deep else DEFAULT_NO_THINK,
    }
    # llama-server accepts top-level chat_template_kwargs too; some builds
    # ignore extra_body. Pass both forms so we don't depend on the build.
    body["chat_template_kwargs"] = body["extra_body"]["chat_template_kwargs"]

    try:
        with httpx.Client(timeout=QWEN_TIMEOUT_SECS) as client:
            r = client.post(f"{QWEN_BASE_URL}/chat/completions", json=body)
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPError as e:
        return f"[qwen-coprocessor] http error: {e}"

    try:
        return data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        return f"[qwen-coprocessor] unexpected response shape: {json.dumps(data)[:600]}"


@mcp.tool()
def qwen(prompt: str, system: str = "", deep: bool = False) -> str:
    """Ask local Qwen 3.6-27B for a quick answer or text transformation.

    Use this to OFFLOAD work from your context window when the task is one
    of these shapes:
      - Mechanically simple (don't burn Claude tokens; Qwen handles it).
      - Bulk/repetitive (you're about to do the same transform many times).
      - Speculative (try a quick approach before committing to the careful one).
      - Low-stakes ("good enough" beats "expensive and perfect").

    Set deep=True for reasoning-heavy delegations (longer problems, multi-step
    derivations). Adds latency; only use when the question warrants it.

    Avoid this tool for:
      - Anything where correctness matters and Qwen's quality might bite you.
      - Tasks that benefit from your full conversation context — Qwen sees
        only what you pass in.
      - Code edits or actions that touch the user's files; you should do
        those yourself.

    Args:
        prompt: The question or instruction for Qwen. Be specific.
        system: Optional system prompt to set Qwen's persona/constraints.
        deep:   True to enable thinking mode (slower, deeper reasoning).

    Returns:
        Qwen's text response.
    """
    if not prompt.strip():
        return "[qwen-coprocessor] error: empty prompt."
    msgs: list[dict] = []
    if system.strip():
        msgs.append({"role": "system", "content": system.strip()})
    msgs.append({"role": "user", "content": prompt.strip()})
    return _call_qwen(msgs, deep=deep, max_tokens=4096 if deep else 2048)


@mcp.tool()
def qwen_classify(
    item: str,
    categories: list[str],
    instruction: str = "",
) -> str:
    """Classify `item` into exactly one of `categories`. Returns the chosen label.

    Use for triage decisions where you need a label and don't want to spend
    Claude's reasoning on it. Examples:
      - Classify a user prompt as 'simple' / 'complex' / 'ambiguous'.
      - Decide if a piece of text is 'bug-report' / 'feature-request' / 'question'.
      - Tag a function as 'pure' / 'side-effecting' / 'IO-bound'.

    Returns the literal category string from `categories`. If Qwen returns
    something not in `categories`, the result is wrapped in '[unrecognized: ...]'
    so you can detect the failure.

    Args:
        item:        The thing to classify (any text).
        categories:  The allowed labels. Pick the one that fits.
        instruction: Optional extra guidance for the classification rule.
    """
    if not categories:
        return "[qwen-coprocessor] error: categories list is empty."
    cats = " | ".join(repr(c) for c in categories)
    sys_prompt = (
        "You are a strict classifier. Reply with EXACTLY ONE of the given "
        "categories — no preamble, no explanation, no quotes."
    )
    user_prompt = (
        (instruction.strip() + "\n\n") if instruction.strip() else ""
    ) + f"Categories: {cats}\n\nItem to classify:\n{item.strip()}\n\nLabel:"
    out = _call_qwen(
        [{"role": "system", "content": sys_prompt},
         {"role": "user", "content": user_prompt}],
        max_tokens=64,
        temperature=0.0,
    )
    out = out.strip().strip("'\"")
    if out in categories:
        return out
    # Tolerate prefix/suffix; pick longest matching category.
    for cat in sorted(categories, key=len, reverse=True):
        if cat in out:
            return cat
    return f"[unrecognized: {out!r}]"


@mcp.tool()
def qwen_summarize(text: str, max_words: int = 100) -> str:
    """Compress `text` to roughly `max_words`. Faithful, terse, no commentary.

    Use to save Claude's context budget when you have a long passage you
    don't need verbatim. Returns just the summary — no preamble like "Here's
    a summary:".

    Args:
        text:      The text to compress.
        max_words: Soft target word count. Qwen aims at this; allow some slack.
    """
    if not text.strip():
        return ""
    sys_prompt = (
        "You write tight, faithful summaries. No preamble, no meta-commentary, "
        "no bullet headers. Just prose summarizing the input."
    )
    user_prompt = (
        f"Summarize the following in approximately {max_words} words.\n\n{text.strip()}"
    )
    return _call_qwen(
        [{"role": "system", "content": sys_prompt},
         {"role": "user", "content": user_prompt}],
        max_tokens=int(max_words * 2.5),
        temperature=0.3,
    ).strip()


@mcp.tool()
def qwen_extract(text: str, schema_description: str) -> str:
    """Extract structured data from `text` per `schema_description`. Returns JSON.

    Use to pull facts out of prose without you having to do the parsing
    yourself: entities, dates, parameters, lists of items.

    `schema_description` is plain English — Qwen will produce a JSON object
    that conforms to your description as best it can.

    Args:
        text:               The source prose.
        schema_description: Plain-English description of what fields you want.
                            Example: "object with keys: name (string),
                            ages (list of integers), pets (list of strings)".

    Returns:
        A JSON string. May not strictly validate; you should json.loads and
        recover from errors. Returns '[invalid_json: ...]' if Qwen's output
        is unparseable.
    """
    if not text.strip():
        return "{}"
    sys_prompt = (
        "You produce ONLY a single JSON object — no preamble, no Markdown "
        "code fences, no commentary. The JSON must conform to the schema "
        "the user describes. If a value is unknown, use null."
    )
    user_prompt = (
        f"Schema: {schema_description.strip()}\n\nSource text:\n{text.strip()}\n\nJSON:"
    )
    raw = _call_qwen(
        [{"role": "system", "content": sys_prompt},
         {"role": "user", "content": user_prompt}],
        max_tokens=2048,
        temperature=0.0,
    ).strip()
    # Strip accidental code fences that some quants emit despite the system prompt.
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:].lstrip()
    try:
        json.loads(raw)
        return raw
    except json.JSONDecodeError as e:
        return f"[invalid_json: {e.msg}; raw={raw[:300]!r}]"


if __name__ == "__main__":
    mcp.run()
