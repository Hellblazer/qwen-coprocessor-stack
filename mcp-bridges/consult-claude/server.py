#!/usr/bin/env -S uv run --script
# SPDX-License-Identifier: MIT
# /// script
# requires-python = ">=3.11"
# dependencies = ["mcp>=1.0.0"]
# ///
"""MCP bridge that exposes a single `consult_claude` tool.

The tool spawns a fresh, subscription-authenticated `claude -p` subprocess
with the qwen-coprocessor gateway environment STRIPPED, so the inner Claude
Code uses the user's normal Anthropic OAuth login — billing flows to the
Pro/Max subscription, not to an API key.

Designed to be invoked by a Qwen-led Claude Code that needs to escalate a
single hard question. Single-turn Q&A only: the inner Claude returns text,
which the outer Qwen treats as a tool result.
"""

from __future__ import annotations

import os
import shutil
import subprocess

from mcp.server.fastmcp import FastMCP

# Env vars that, if present, would route the inner `claude` back through
# our LiteLLM gateway and defeat the whole point. Strip them before spawn.
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

# Wall-clock cap on a single consultation. Claude itself can think for a
# while; we don't want to wedge the Qwen loop indefinitely.
CONSULT_TIMEOUT_SECS = int(os.environ.get("CONSULT_TIMEOUT_SECS", "600"))

# Resolve the claude binary up front so we fail loudly at startup, not
# inside a tool call where the error message is harder to surface.
CLAUDE_BIN = os.environ.get("CLAUDE_BIN") or shutil.which("claude")
if not CLAUDE_BIN:
    raise RuntimeError(
        "consult-claude MCP server: cannot find `claude` on PATH. "
        "Set CLAUDE_BIN to the absolute path or install Claude Code first."
    )


mcp = FastMCP("consult-claude")


@mcp.tool()
def consult_claude(question: str, context: str = "") -> str:
    """Ask the user's subscription-authenticated Claude a single hard question.

    USE THIS SPARINGLY. It costs subscription quota and adds 5-30s of latency
    per call. Reach for it ONLY when the local Qwen model genuinely cannot
    handle the problem. Good triggers:
      - Formal proofs or rigorous mathematical derivations.
      - Multi-file architectural decisions where you need a second opinion.
      - Subtle bugs where you've already tried 2+ fixes and remain stuck.
      - Tasks explicitly tagged "@claude" by the user.

    Bad triggers (do NOT escalate for these):
      - Routine code generation, refactors, or syntax questions.
      - Looking up library APIs (use docs / Context7 first).
      - Anything you have not yet attempted yourself.

    The inner Claude does not see your conversation. Pass enough `context`
    that it can answer the question standalone — relevant code snippets,
    constraints, and what you've already ruled out.

    Args:
        question: The specific question to ask. Be concrete.
        context: Background the inner Claude needs (code, prior attempts,
            constraints). Keep under ~10 KB.

    Returns:
        Claude's answer as plain text. Treat it as advice; you remain
        responsible for whatever action you take next.
    """
    if not question.strip():
        return "[consult_claude] error: empty question."

    prompt = (f"{context.strip()}\n\n---\n\n{question.strip()}"
              if context.strip() else question.strip())

    env = {k: v for k, v in os.environ.items() if k not in GATEWAY_ENV}

    try:
        result = subprocess.run(
            [CLAUDE_BIN, "-p", prompt],
            env=env,
            capture_output=True,
            text=True,
            timeout=CONSULT_TIMEOUT_SECS,
        )
    except subprocess.TimeoutExpired:
        return (f"[consult_claude] timed out after {CONSULT_TIMEOUT_SECS}s. "
                "Consider narrowing the question or handling it locally.")
    except FileNotFoundError:
        return f"[consult_claude] claude binary not found at {CLAUDE_BIN}."

    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        return f"[consult_claude] exit={result.returncode}: {stderr[:2000]}"

    answer = (result.stdout or "").strip()
    return answer or "[consult_claude] empty response from Claude."


if __name__ == "__main__":
    mcp.run()
