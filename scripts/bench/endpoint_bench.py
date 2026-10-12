#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Prefill and decode throughput of an OpenAI-compatible endpoint.

Runtime-neutral on purpose: llama-bench only measures llama.cpp, so numbers
taken with it cannot be set beside MLX. This drives /v1/chat/completions with
a streamed request and derives both rates from the wall clock and the
server's own `usage` counts:

    prefill tok/s = prompt_tokens / time-to-first-token
    decode  tok/s = (completion_tokens - 1) / (last token - first token)

Time-to-first-token includes request overhead, so prefill reads slightly low
on short prompts. Every prompt starts with a fresh nonce so a server-side
prompt cache cannot turn a prefill into a cache hit.

Reproduce a known figure on a known endpoint before trusting a new one
(CLAUDE.md eval rule 1).

    endpoint_bench.py --url http://qwentescence:1235 --model qwen --sizes 8000,64000
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.request
import uuid
from pathlib import Path

FILLER_GLOB = "mcp-bridges/qwen-agent-server/src/*.ts"


def load_filler(repo_root: Path) -> str:
    parts = [p.read_text(encoding="utf-8", errors="replace") for p in sorted(repo_root.glob(FILLER_GLOB))]
    if not parts:
        raise SystemExit(f"no filler text under {repo_root}/{FILLER_GLOB}")
    return "\n".join(parts)


def build_prompt(filler: str, chars: int) -> str:
    body = (filler * (chars // len(filler) + 1))[:chars]
    return f"run {uuid.uuid4().hex}\n\n{body}\n\nSummarize what the code above does, in detail."


def run_once(url: str, model: str, prompt: str, max_tokens: int, api_key: str | None, timeout: float) -> dict:
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0.7,
        "top_p": 0.8,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(f"{url.rstrip('/')}/v1/chat/completions", json.dumps(payload).encode(), headers)
    t0 = time.monotonic()
    t_first = t_last = None
    chunks = 0
    usage: dict = {}
    timings: dict = {}
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        for raw in resp:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            obj = json.loads(data)
            if obj.get("usage"):
                usage = obj["usage"]
            if obj.get("timings"):
                timings = obj["timings"]
            for choice in obj.get("choices") or []:
                delta = choice.get("delta") or {}
                if delta.get("content") or delta.get("reasoning_content"):
                    now = time.monotonic()
                    t_first = t_first or now
                    t_last = now
                    chunks += 1
    if t_first is None or t_last is None:
        raise RuntimeError("no content tokens received")
    prompt_tokens = usage.get("prompt_tokens")
    completion_tokens = usage.get("completion_tokens") or chunks
    ttft = t_first - t0
    decode_s = t_last - t_first
    return {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "ttft_s": round(ttft, 2),
        "prefill_tps": round(prompt_tokens / ttft, 1) if prompt_tokens else None,
        "decode_tps": round((completion_tokens - 1) / decode_s, 1) if decode_s > 0 and completion_tokens > 1 else None,
        "usage_from_server": bool(usage),
        # llama-server reports its own rates; kept as a cross-check, never as the headline.
        "server_prefill_tps": round(timings["prompt_per_second"], 1) if "prompt_per_second" in timings else None,
        "server_decode_tps": round(timings["predicted_per_second"], 1) if "predicted_per_second" in timings else None,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", required=True, help="endpoint base, without /v1")
    ap.add_argument("--model", required=True)
    ap.add_argument("--sizes", default="8000,64000", help="target prompt sizes in tokens, comma-separated")
    ap.add_argument("--max-tokens", type=int, default=400)
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--chars-per-token", type=float, default=0.0, help="skip calibration and use this ratio")
    ap.add_argument("--api-key", default=None)
    ap.add_argument("--timeout", type=float, default=1800.0)
    ap.add_argument("--label", default="")
    ap.add_argument("--out", default=None, help="append one JSON line per run to this file")
    args = ap.parse_args()

    filler = load_filler(Path(__file__).resolve().parents[2])
    ratio = args.chars_per_token
    if not ratio:
        probe = run_once(args.url, args.model, build_prompt(filler, 12000), 8, args.api_key, args.timeout)
        if not probe["prompt_tokens"]:
            raise SystemExit("server returned no usage; pass --chars-per-token")
        ratio = 12000 / probe["prompt_tokens"]
        print(f"calibrated {ratio:.2f} chars/token", file=sys.stderr)

    for size in (int(s) for s in args.sizes.split(",")):
        runs = []
        for i in range(args.repeats):
            r = run_once(args.url, args.model, build_prompt(filler, int(size * ratio)), args.max_tokens, args.api_key, args.timeout)
            r.update(label=args.label, url=args.url, target_tokens=size, run=i, at=time.strftime("%Y-%m-%dT%H:%M:%S%z"))
            runs.append(r)
            print(json.dumps(r), flush=True)
            if args.out:
                with open(args.out, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(r) + "\n")
        pre = [r["prefill_tps"] for r in runs if r["prefill_tps"]]
        dec = [r["decode_tps"] for r in runs if r["decode_tps"]]
        print(
            f"== {args.label or args.url} @ {size}: prefill median {statistics.median(pre) if pre else None} tok/s, "
            f"decode median {statistics.median(dec) if dec else None} tok/s (n={len(runs)})",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
