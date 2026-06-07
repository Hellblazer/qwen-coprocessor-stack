#!/usr/bin/env python3
"""End-to-end shakeout of the qwen coprocessor inference endpoint.

Exercises every live capability against an OpenAI-compatible llama.cpp server:
text chat, JSON-schema coprocessor synthesis, tool-calling, vision (scene),
OCR (text-in-image), and tokenize. Embedding/rerank servers are probed and
reported but not required.

Stdlib only (urllib) + Pillow for image synthesis. No external deps.

    python3 scripts/shakeout.py                 # defaults to qwentescence:1234
    QWEN_URL=http://localhost:8080 python3 scripts/shakeout.py
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("QWEN_URL", "http://qwentescence:1234").rstrip("/")
# Embed/rerank default to localhost — that's where start-embed-server.sh and
# start-rerank-server.sh bind them. Override for a remote deployment.
EMBED = os.environ.get("QWEN_EMBED_URL", "http://localhost:8081").rstrip("/")
RERANK = os.environ.get("QWEN_RERANK_URL", "http://localhost:8082").rstrip("/")
TIMEOUT = int(os.environ.get("QWEN_TIMEOUT", "240"))

OCR_PASSPHRASE = "VOLTAIC-7Q-MARMOSET"

results: list[tuple[str, bool, str]] = []


def rec(name: str, ok: bool, detail: str) -> None:
    results.append((name, ok, detail))
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {name}: {detail}", flush=True)


def post(path: str, payload: dict, base: str = BASE, timeout: int = TIMEOUT) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        base + path, data=data, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def get(path: str, base: str = BASE, timeout: int = 10) -> dict:
    with urllib.request.urlopen(base + path, timeout=timeout) as r:
        return json.loads(r.read().decode())


def chat(messages, *, temperature=0.0, max_tokens=512, **extra) -> dict:
    payload = {
        "model": "qwen",
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        **extra,
    }
    return post("/v1/chat/completions", payload)


def content_of(resp: dict) -> str:
    return (resp["choices"][0]["message"].get("content") or "").strip()


# ---------------------------------------------------------------- image synthesis
def png_ocr() -> bytes:
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (760, 300), "white")
    d = ImageDraw.Draw(img)
    try:
        big = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 34)
        med = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 24)
    except Exception:
        big = med = ImageFont.load_default()
    d.text((24, 20), "INVOICE #4471", fill="black", font=big)
    d.text((24, 90), f"Access code: {OCR_PASSPHRASE}", fill="black", font=med)
    d.text((24, 140), "Qty: 12    Unit: $7.50    Total: $90.00", fill="black", font=med)
    d.text((24, 200), "Due date: 2026-07-15", fill="black", font=med)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def png_scene() -> bytes:
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (400, 400), "white")
    d = ImageDraw.Draw(img)
    d.ellipse([40, 40, 180, 180], fill="red")            # red circle, top-left
    d.rectangle([220, 240, 360, 360], fill="blue")        # blue square, bottom-right
    d.polygon([(300, 40), (240, 160), (360, 160)], fill="green")  # green triangle
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def data_uri(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png).decode()


def vision_msg(text: str, png: bytes) -> list:
    return [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": text},
                {"type": "image_url", "image_url": {"url": data_uri(png)}},
            ],
        }
    ]


# ----------------------------------------------------------------------- tests
def t_identity():
    props = get("/props")
    mods = props.get("modalities", {})
    model = os.path.basename(props.get("model_path", "?"))
    nctx = props.get("default_generation_settings", {}).get("n_ctx")
    rec("identity", True, f"model={model} n_ctx={nctx} vision={mods.get('vision')}")
    return mods.get("vision", False)


def t_chat():
    t0 = time.time()
    # Qwen3.6 is a reasoning model: the think block precedes content and eats
    # the token budget. Operators must allow generous max_tokens or content
    # comes back empty with finish_reason=length.
    r = chat([{"role": "user", "content": "Reply with exactly one word: the capital of France."}],
             max_tokens=768)
    out = content_of(r)
    dt = time.time() - t0
    ok = "paris" in out.lower()
    rec("text-chat", ok, f"{dt:.1f}s -> {out!r}")


def t_coprocessor_json():
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
    r = chat(
        [{"role": "user", "content":
          f"Extract every top-level function name (include private _-prefixed, "
          f"exclude class methods). Code:\n{code}"}],
        response_format={"type": "json_schema",
                         "json_schema": {"name": "fns", "schema": schema, "strict": True}},
        max_tokens=2048,
    )
    dt = time.time() - t0
    fin = r["choices"][0].get("finish_reason")
    out = content_of(r)
    if not out and fin == "length":
        rec("coprocessor-json", False,
            f"{dt:.1f}s reasoning starved output (finish=length) — raise max_tokens")
        return
    try:
        got = set(json.loads(out).get("functions", []))
    except Exception as e:
        rec("coprocessor-json", False, f"{dt:.1f}s invalid JSON: {e}: {out[:120]!r}")
        return
    expect = {"ingest", "_norm", "upsert", "compose"}
    ok = expect.issubset(got) and "get" not in got
    rec("coprocessor-json", ok, f"{dt:.1f}s got={sorted(got)}")


def t_tools():
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
    ok = False
    detail = "no tool_call emitted"
    if calls:
        fn = calls[0]["function"]
        try:
            args = json.loads(fn["arguments"])
        except Exception:
            args = {}
        ok = fn["name"] == "get_weather" and "tokyo" in str(args).lower()
        detail = f"{fn['name']}({args})"
    rec("tool-calling", ok, f"{dt:.1f}s {detail}")


def t_vision(enabled: bool):
    if not enabled:
        rec("vision-scene", False, "skipped — server reports vision disabled")
        return
    t0 = time.time()
    r = chat(vision_msg(
        "List the colored shapes you see and their colors. Be brief.", png_scene()),
        max_tokens=256)
    dt = time.time() - t0
    out = content_of(r).lower()
    hits = [c for c in ("red", "blue", "green") if c in out]
    shapes = [s for s in ("circle", "square", "triangle", "rectangle") if s in out]
    ok = len(hits) >= 2 and len(shapes) >= 2
    rec("vision-scene", ok, f"{dt:.1f}s colors={hits} shapes={shapes} :: {out[:90]!r}")


def t_ocr(enabled: bool):
    if not enabled:
        rec("ocr", False, "skipped — server reports vision disabled")
        return
    t0 = time.time()
    r = chat(vision_msg(
        "Transcribe ALL text in this image exactly, preserving codes and numbers.",
        png_ocr()), max_tokens=512)
    dt = time.time() - t0
    out = content_of(r)
    up = out.upper()
    checks = {
        "passphrase": OCR_PASSPHRASE in up,
        "invoice#": "4471" in up,
        "total": "90.00" in up or "$90" in up,
        "due-date": "2026-07-15" in up,
    }
    ok = sum(checks.values()) >= 3 and checks["passphrase"]
    rec("ocr", ok, f"{dt:.1f}s {checks} :: {out[:90]!r}")


def t_tokenize():
    try:
        r = post("/tokenize", {"content": "The quick brown fox jumps over the lazy dog."},
                 timeout=15)
    except Exception as e:
        rec("tokenize", False, f"endpoint error: {e}")
        return
    toks = r.get("tokens", [])
    rec("tokenize", len(toks) > 0, f"{len(toks)} tokens")


def _cosine(a: list[float], b: list[float]) -> float:
    import math

    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def t_embed():
    try:
        r = post("/v1/embeddings",
                 {"model": "bge-m3",
                  "input": ["a cat sat on the mat", "a kitten rested on the rug",
                            "quarterly revenue rose 12 percent"]},
                 base=EMBED, timeout=30)
    except Exception as e:
        rec("embed", False, f"unreachable at {EMBED}: {e}")
        return
    vecs = [d["embedding"] for d in r["data"]]
    dim = len(vecs[0])
    sim = _cosine(vecs[0], vecs[1])     # cat ~ kitten
    dis = _cosine(vecs[0], vecs[2])     # cat vs revenue
    ok = dim > 0 and sim > dis
    rec("embed", ok, f"dim={dim} sim(cat,kitten)={sim:.3f} > sim(cat,revenue)={dis:.3f}")


def t_rerank():
    docs = ["pancakes are fluffy breakfast food",
            "the giant panda is a bear native to China",
            "a panda's diet is almost entirely bamboo"]
    try:
        r = post("/v1/rerank",
                 {"model": "bge-reranker-v2-m3", "query": "what does a panda eat?",
                  "documents": docs}, base=RERANK, timeout=30)
    except Exception as e:
        rec("rerank", False, f"unreachable at {RERANK}: {e}")
        return
    ranked = sorted(r["results"], key=lambda x: x["relevance_score"], reverse=True)
    top = ranked[0]["index"]
    ok = top == 2  # the bamboo-diet doc is the best answer
    rec("rerank", ok, f"top=doc[{top}] {docs[top][:40]!r}")


# ---------------------------------------------------------------------- main
def main() -> int:
    print(f"== qwen coprocessor shakeout :: {BASE} ==\n")
    try:
        vision = t_identity()
    except Exception as e:
        print(f"FATAL: cannot reach {BASE}: {e}")
        return 2
    t_chat()
    t_coprocessor_json()
    t_tools()
    t_vision(vision)
    t_ocr(vision)
    t_tokenize()
    t_embed()
    t_rerank()

    print("\n== summary ==")
    core = results
    passed = sum(1 for _, ok, _ in core if ok)
    for name, ok, _ in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    print(f"\ncore capabilities: {passed}/{len(core)} passed")
    return 0 if passed == len(core) else 1


if __name__ == "__main__":
    sys.exit(main())
