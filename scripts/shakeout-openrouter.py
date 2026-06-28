#!/usr/bin/env python3
"""Shakeout of an authenticated remote OpenAI-compatible endpoint (RDR-012).

Verifies that the credential + header plumbing the supervisor relies on works
against a real remote provider (OpenRouter by default; any OpenAI-compatible
auth'd endpoint via env). Exercises the capabilities the direct-HTTP tool path
uses: /v1/models (auth handshake), text chat, JSON-schema synthesis, and
tool-calling. This is the remote analogue of scripts/shakeout.py (which targets
a local no-auth llama-server).

This validates the PROVIDER, not the supervisor. It POSTs directly the same way
openai-compat.ts does (Authorization: Bearer <key> + optional attribution
headers), so a green run means the supervisor's backend entry for this provider
will work for the direct-HTTP tools (qwen_chat / qwen_embed / qwen_rerank /
qwen_tokenize / qwen_oneshot_vision) and — once RDR-012 lands — the agentic path.

Stdlib only (urllib). No external deps.

    OPENROUTER_API_KEY=sk-or-... python3 scripts/shakeout-openrouter.py
    OPENROUTER_API_KEY=... OPENROUTER_MODEL=anthropic/claude-sonnet-4.5 \
        python3 scripts/shakeout-openrouter.py

    # Any OpenAI-compatible provider:
    OPENROUTER_BASE_URL=https://api.together.xyz/v1 \
        OPENROUTER_API_KEY=$TOGETHER_API_KEY \
        OPENROUTER_MODEL=meta-llama/Llama-3.3-70B-Instruct-Turbo \
        python3 scripts/shakeout-openrouter.py

Exit code is non-zero if any required test fails (CI-friendly).
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/")
API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
MODEL = os.environ.get("OPENROUTER_MODEL", "anthropic/claude-sonnet-4.5")
TIMEOUT = int(os.environ.get("OPENROUTER_TIMEOUT", "120"))

# Optional attribution headers — mirror the supervisor's `backend.headers`
# (honored on the direct-HTTP path; see RDR-012 for the agentic-path caveat).
HEADERS_EXTRA = {
    "HTTP-Referer": os.environ.get(
        "OPENROUTER_REFERER", "https://github.com/Hellblazer/qwen-coprocessor-stack"
    ),
    "X-Title": os.environ.get("OPENROUTER_TITLE", "qwen-coprocessor-stack"),
}

results: list[tuple[str, bool, str]] = []


def rec(name: str, ok: bool, detail: str) -> None:
    results.append((name, ok, detail))
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {name}: {detail}", flush=True)


def _headers() -> dict:
    h = {"Content-Type": "application/json", **HEADERS_EXTRA}
    if API_KEY:
        h["Authorization"] = f"Bearer {API_KEY}"
    return h


def post(path: str, payload: dict, timeout: int = TIMEOUT) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=data, headers=_headers())
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def get(path: str, timeout: int = 30) -> dict:
    req = urllib.request.Request(BASE + path, headers=_headers())
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def chat(messages, *, temperature=0.0, max_tokens=512, **extra) -> dict:
    payload = {
        "model": MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        **extra,
    }
    return post("/chat/completions", payload)


def content_of(resp: dict) -> str:
    return (resp["choices"][0]["message"].get("content") or "").strip()


# ----------------------------------------------------------------------- tests
def t_auth_models() -> bool:
    """GET /v1/models — the auth handshake. A 401 here means the key is wrong;
    this is the same endpoint the supervisor's health probe falls back to."""
    t0 = time.time()
    try:
        r = get("/models")
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:200]
        rec("auth-models", False, f"HTTP {e.code}: {body!r}")
        return False
    n = len(r.get("data", []))
    dt = time.time() - t0
    ok = n > 0
    rec("auth-models", ok, f"{dt:.1f}s -> {n} models visible")
    return ok


def t_chat() -> None:
    t0 = time.time()
    r = chat(
        [{"role": "user", "content": "Reply with exactly one word: the capital of France."}],
        max_tokens=64,
    )
    out = content_of(r)
    dt = time.time() - t0
    rec("text-chat", "paris" in out.lower(), f"{dt:.1f}s -> {out!r}")


def t_json_schema() -> None:
    code = (
        "def ingest(p): return open(p).read()\n"
        "def _norm(t): return t.strip()\n"
        "async def upsert(r): await db.write(r)\n"
        "class S:\n    def get(self,k): ...\n"
        "def compose(a,b): return _norm(a)+b"
    )
    schema = {
        "type": "object",
        "properties": {"functions": {"type": "array", "items": {"type": "string"}}},
        "required": ["functions"],
    }
    t0 = time.time()
    try:
        r = chat(
            [{"role": "user", "content":
              f"Extract every top-level function name (include private _-prefixed, "
              f"exclude class methods). Code:\n{code}"}],
            response_format={"type": "json_schema",
                             "json_schema": {"name": "fns", "schema": schema, "strict": True}},
            max_tokens=512,
        )
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:200]
        # Not all providers/models support strict json_schema — report, don't crash.
        rec("json-schema", False, f"HTTP {e.code} (model may not support json_schema): {body!r}")
        return
    dt = time.time() - t0
    out = content_of(r)
    try:
        got = set(json.loads(out).get("functions", []))
    except Exception as e:
        rec("json-schema", False, f"{dt:.1f}s invalid JSON: {e}: {out[:120]!r}")
        return
    expect = {"ingest", "_norm", "upsert", "compose"}
    ok = expect.issubset(got) and "get" not in got
    rec("json-schema", ok, f"{dt:.1f}s got={sorted(got)}")


def t_tools() -> None:
    tools = [{
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get current weather for a city",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    }]
    t0 = time.time()
    r = chat([{"role": "user", "content": "What's the weather in Tokyo? Use the tool."}],
             tools=tools, tool_choice="auto", max_tokens=256)
    dt = time.time() - t0
    msg = r["choices"][0]["message"]
    calls = msg.get("tool_calls") or []
    if not calls:
        rec("tool-calling", False, f"{dt:.1f}s no tool_calls in response")
        return
    fn = calls[0].get("function", {})
    try:
        args = json.loads(fn.get("arguments", "{}"))
    except Exception:
        args = {}
    ok = fn.get("name") == "get_weather" and "tokyo" in str(args.get("city", "")).lower()
    rec("tool-calling", ok, f"{dt:.1f}s -> {fn.get('name')}({args})")


def main() -> int:
    print(f"Remote OpenAI-compatible shakeout: {BASE}  model={MODEL}", flush=True)
    if not API_KEY:
        print("  [FAIL] no OPENROUTER_API_KEY set — refusing to probe unauthenticated.",
              flush=True)
        return 2

    if not t_auth_models():
        print("\nAuth handshake failed — aborting remaining tests.", flush=True)
        return 1

    t_chat()
    t_json_schema()
    t_tools()

    failed = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed", flush=True)
    if failed:
        print(f"FAILED: {', '.join(failed)}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
