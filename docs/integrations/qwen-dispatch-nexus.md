# qwen_dispatch — informal upstream nexus design sketch

**Status:** SHIPPED 2026-05-10. Upstream PRs merged:
- **nexus#623** (initial qwen_dispatch + per-operator routing) — merged 2026-05-10T00:31Z
- **nexus#626** (promote `extract` to qwen-default + conftest env isolation) — merged 2026-05-10T01:26Z

End state under `NEXUS_DISPATCH_BACKEND=auto`:
- `QWEN_OPERATORS_DEFAULT` = all 10 bundleable operators (summarize, compare, rank, filter, aggregate, groupby, verify, check, generate, **extract**)
- `CLAUDE_OPERATORS_PINNED` = ∅ (empty — placeholder for future precision-driven pins)

`extract` promotion rationale (#626): a dedicated extract-precision bench
(4 cases × 5 repeats = 20 dispatches against qwentescence) returned **20/20
oracle-match**, including the original `extract-function-names` miss-case
(5/5). The original miss was sampling variance, not a systematic Qwen
weakness. Bench harness gained `--repeat N` and per-case `oracle`
(set/exact match) for the validation. **If we re-validate this later, run
that bench with --repeat ≥ 5 against a current qwentescence model and look
for any oracle miss; one is enough to re-pin extract.**

### Re-validation 2026-05-14

Re-ran with the in-tree harness:

```bash
cd mcp-bridges/qwen-agent-server
npm run bench -- --operator extract --repeat 5 --only qwen --timeout-ms 180000
```

Result against qwentescence (qwen3.6-35b-a3b):

```
qwen  ok=20/20  json_valid=20/20  oracle=20/20  median=17.8s  total=370s
```

All 4 extract cases × 5 repeats clean. No miss on the original
`extract-function-names` case. **Promotion holds.** Run output at
`scripts/bench/out/bench-2026-05-14T21-33-03-340Z.jsonl` (local —
`scripts/bench/out/` is gitignored).

`--repeat`, `--operator <name>`, `--case <name>`, and oracle grading
landed in the in-tree harness (commit 72b21e8), so the next
re-validation is a single `npm run bench` invocation.

Original sketch below preserved for history.

---

## Background

The v0.7 delegation report identified `nexus/operators/dispatch.py:claude_dispatch` as the highest-leverage seam for Qwen offload. The v0.8 supervisor primitives (`thinking_mode`, `json_schema`, `qwen_oneshot`, fence-strip in v0.8.1) are now ready. The bench shipped 5/5 schema-conforming output for both engines on operator-shaped prompts, with Qwen ~1.7× slower per call but free at margin and content-comparable on summarize / compare / rank.

This doc sketches the upstream change in the nexus repo. Goal is to validate the shape before committing engineering time, not to ship it now.

## What we're swapping

The seam, repeated for clarity:

```python
# nexus/operators/dispatch.py:163
async def claude_dispatch(prompt: str, json_schema: dict, timeout: float = 300.0) -> dict:
    # spawns: claude -p --output-format json --json-schema <schema>
    # reads: stdout → JSON.parse(envelope.structured_output)
    # returns: parsed dict
```

Called from `nexus/plans/bundle.py:737` (per-operator) and `nexus/plans/runner.py` (per-bundle). The prompt is built host-side from retrieval results; the dispatch function only cares about prompt-and-schema → JSON-out.

**Bundleable operators** (`nexus/plans/bundle.py:74`): `extract, rank, compare, summarize, generate, filter, check, verify, groupby, aggregate`. 10 verbs. The bench measured 5 of them.

## Three patterns for reaching Qwen from Python

### Pattern 1 — Direct OpenAI-compat (recommended)

Nexus builds its own httpx call to llama-server's `/v1/chat/completions`. Bypasses the qwen-stack supervisor entirely.

```python
# nexus/operators/qwen_dispatch.py (sketch)
async def qwen_dispatch(
    prompt: str,
    json_schema: dict,
    *,
    timeout: float = 300.0,
    backend_url: str | None = None,
    model: str | None = None,
) -> dict:
    backend_url = backend_url or _resolve_qwen_backend_url()
    model = model or _resolve_qwen_model()
    system = _build_qwen_system_prompt(json_schema)
    user = f"/no_think\n\n{prompt}"

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            f"{backend_url}/chat/completions",
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "temperature": 0.2,
                "stream": False,
            },
        )
        resp.raise_for_status()
        raw = resp.json()["choices"][0]["message"]["content"]

    stripped = _strip_code_fences(raw)
    return json.loads(stripped)
```

`_build_qwen_system_prompt` mirrors the qwen-stack v0.8.1 directive: "begin with `{` or `[`, no fences, JSON only, schema follows."

`_strip_code_fences` is the same regex from `qwen-coprocessor-stack/mcp-bridges/qwen-agent-server/src/server.ts`.

`_resolve_qwen_backend_url` reads `QWEN_BACKEND_URL` env then falls through to `~/.qwen-coprocessor-stack/config.json` `backends[0].url`. Same shape as qwen-stack's resolution, no new config file.

**Pros:**
- ~80 lines of code, no new MCP dep, no subprocess.
- Same OpenAI-compat path llama.cpp uses for everyone.
- Trivial to bench, swap in/out, monitor.
- Nexus's existing `httpx` dep is already in use elsewhere.

**Cons:**
- Loses the supervisor's pool-cap / queueing. With one llama-server, this isn't load-bearing — llama-server serves one request at a time anyway. Concurrent dispatches naturally serialize.
- Loses budget guardrails. For oneshot dispatch they don't apply (no multi-turn accumulation).
- Loses the supervisor's structured logging. Mitigation: nexus can log around the call site itself.

### Pattern 2 — Python MCP client → supervisor

Nexus spawns or connects to the qwen-stack supervisor and calls `qwen_oneshot` over MCP stdio.

**Pros:**
- Reuses the supervisor's value-add (pool, logging, future budget caps).
- One canonical Qwen entrypoint across all callers.

**Cons:**
- Substantial plumbing — Python MCP client, supervisor lifecycle (spawn-once-keep-warm vs spawn-per-call), the qwen-agent-server already-running detection.
- Recursion concern: nexus dispatch runs inside `claude -p` subprocesses sometimes (for nested planners). Those subprocesses don't share MCP servers with the parent. Each nested level would spawn its own supervisor or accept high startup cost.
- The supervisor's value-add (pool, multi-turn) doesn't apply to oneshot dispatch, which is the workload we're optimizing.

### Pattern 3 — Wrapper CLI

Ship a `qwen-oneshot` binary on PATH (in qwen-stack or in nexus) that takes prompt+schema and prints JSON. `claude_dispatch` becomes `dispatch_to(prompt, schema, dispatcher="qwen-oneshot")` — minimal change to dispatch.py.

**Pros:**
- Maximum drop-in — same subprocess shape as `claude -p`.
- Operator can run `qwen-oneshot < prompt.txt --schema schema.json` for ad-hoc debugging.

**Cons:**
- One more binary to package, version, document.
- Subprocess spawn cost (~50ms) on every call vs httpx (~1ms).
- Mostly cosmetic — doesn't add capability over Pattern 1.

**Recommendation: Pattern 1.** Shortest path; loses nothing load-bearing for this workload; aligns with how everyone else talks to llama-server.

## Routing logic

Per-operator pinning, defaulting to Claude until validated:

```python
# nexus/operators/dispatch_router.py (sketch)

# Routing table grounded in 10/10 bench coverage (qwen-stack repo,
# scripts/bench/, run 2026-05-09T23-47-13Z):
#
#   schema-valid: 10/10 both engines
#   median latency: claude 15.0s, qwen 20.4s (ratio 1.36×)
#   content tied or near-tied: 9/10 cases
#   content qwen-loss: 1/10 (extract: missed _normalize underscore-
#     prefixed function — Qwen heuristically filtered "private-looking"
#     identifiers despite the "every top-level function" prompt)
#   content qwen-near-loss: filter kept the input's "3. " enum prefix;
#     fine if the consumer doesn't care, sloppy if it does
#
# Notably: verify and check held up under precision testing. The prior
# sketch pinned them to Claude as "precision-critical" by extrapolation
# from extract's miss; the actual evidence says they're tied.
QWEN_OPERATORS_DEFAULT = frozenset({
    "summarize", "compare", "rank",
    "aggregate", "groupby",
    "verify", "check",
    "generate",
})
CLAUDE_OPERATORS_PINNED = frozenset({"extract"})  # only clear bench loss
EITHER = frozenset({"filter"})  # tied on content, formatting drift risk

def pick_dispatcher(operator_name: str) -> Literal["qwen", "claude"]:
    bare = operator_name.removeprefix("operator_")
    override = os.getenv("NEXUS_DISPATCH_BACKEND")
    if override in {"qwen", "claude"}:
        return override
    if env_set := os.getenv("NEXUS_DISPATCH_QWEN_OPERATORS"):
        qwen_set = {x.strip() for x in env_set.split(",")}
        if bare in qwen_set:
            return "qwen"
        return "claude"
    if bare in QWEN_OPERATORS_DEFAULT:
        return "qwen"
    return "claude"
```

**Default-Claude is the opt-in-protective choice.** Operator flips one operator at a time, watches metrics for a week, expands when comfortable. Same operator-chooses pattern as the rest of the stack.

The router lives at `dispatch_bundle` time (per-bundle decision based on the bundle's first operator), not per-step inside a bundle — `claude_dispatch` is bundle-scoped, not step-scoped.

## Failure handling

Three modes worth thinking about:

1. **HTTP error / timeout from llama-server.** Same shape as `OperatorTimeoutError` / `OperatorError`. Nexus already has the pattern.
2. **JSON parse failure (model emitted prose).** Retry once with a tighter prompt prepended (`"Your last response was not valid JSON. Try again — begin with { or ["). On second failure, escalate.
3. **Schema-valid but semantically off** (e.g. Qwen's `_normalize`-miss). Not detectable at dispatch time. Mitigated by per-operator pinning — don't route precision-critical operators to Qwen.

**Fallback to Claude on failure?** Tempting but adds latency on every Qwen failure. Better default: fail explicitly, let the operator see it, decide whether to flip routing back. Auto-fallback is a v2 feature.

## Concurrency

Llama-server serves one request at a time. If nexus parallelizes plan execution (e.g. 5 user sessions firing dispatches simultaneously), they queue at llama-server. Tail latency blows up.

**Mitigation in `qwen_dispatch`:** module-level `asyncio.Semaphore(N)` with `N` = backend concurrency cap. Default 1 for a single llama-server. Configurable via env. Aligns with what llama-server can actually do.

```python
_QWEN_SEMAPHORE = asyncio.Semaphore(int(os.getenv("NEXUS_QWEN_CONCURRENCY", "1")))

async def qwen_dispatch(...):
    async with _QWEN_SEMAPHORE:
        # ...the httpx call above
```

## Cost telemetry

Nexus tracks `claude -p` cost via `total_cost_usd` from the envelope. Qwen calls are zero. Add a "would-have-cost" estimator if useful — multiply input+output tokens by current Sonnet rates. Optional; mostly satisfies operator curiosity ("how much did we save this week").

Or skip it. Most useful telemetry is per-operator:
- p50 / p95 latency per dispatcher
- JSON-validity rate per dispatcher
- semaphore wait time (if Qwen concurrency is > 1)

## Migration / staging

1. **Ship qwen_dispatch + router + tests.** Default routing all-Claude, no behavior change. Get the code in, light up CI.
2. **Operator flips one operator** via `NEXUS_DISPATCH_QWEN_OPERATORS=summarize`. Re-runs `/nx:query` traffic for a few days. Eyeballs latency + correctness.
3. **Expand or roll back.** Either add another operator to the env, or revert the env flag. No code change required either way.
4. **After 2-3 operators are validated**, propose updating `QWEN_OPERATORS_DEFAULT` so the env flag becomes unnecessary. PR moment.

This is reversible at every step. No flag day, no all-or-nothing migration.

## Open questions / risks

- **Qwen content drift over time** as the operator updates the model on qwentescence. Mitigation: re-run the bench after each model upgrade. The bench is small (5 cases × 2 engines = ~3 min wall-clock) so it's cheap to re-run.
- **Hallucination on general-knowledge questions** where retrieval doesn't ground a fact. Bites operators like `compare` or `summarize` if the retrieved chunks are insufficient. Doesn't reproduce in our bench (the prompts are self-contained) but could appear in real `/nx:query` traffic. Detection: cross-model agreement check on a sample of production traffic.
- ~~**Bench coverage gap.** We measured 5 of 10 operators.~~ Resolved 2026-05-09: 10/10 coverage. All 10 operators schema-valid; content tied on 9/10. Only `extract` shows a real Qwen content loss (missed `_normalize`); `filter` shows formatting drift but content correctness.
- **Per-operator routing config bloat.** If the routing table grows, we'd want a real config block (not env). Punt until 5+ operators are individually pinned.
- **Streaming.** The current `claude_dispatch` is non-streaming (single subprocess invocation, parse stdout). Qwen dispatch matches. If nexus adds a streaming dispatch path, both backends would need streaming counterparts.

## What I'd write if I were filing the PR today

```
nexus: add qwen_dispatch + per-operator routing

Adds an OpenAI-compat alternative to claude_dispatch for selected
bundleable operators. Default routing remains all-Claude; operators
opt in via NEXUS_DISPATCH_BACKEND or NEXUS_DISPATCH_QWEN_OPERATORS.

Validated against qwen-coprocessor-stack v0.8.1 supervisor + Qwen3.6-
35B-A3B Q4_K_XL on qwentescence (Strix Halo Vulkan). Bench (in that
repo at scripts/bench/) covers all 10 bundleable operators with
10/10 schema-conforming output on both engines. Median latency:
Claude 15.0s, Qwen 20.4s (ratio 1.36×).

Content equivalence: 9/10 tied or near-tied. Only clear Qwen content
loss is `extract` (missed an underscore-prefixed function); `filter`
shows minor formatting drift (kept input enum prefix).

Routing default ships extract pinned to Claude (only clear loss),
filter as either (formatting risk only), and the remaining eight
operators (summarize, compare, rank, aggregate, groupby, verify,
check, generate) defaulting to Qwen. verify and check were initially
pinned-to-Claude in earlier drafts but bench measurement showed they
held up under precision testing — both correctly identified the
fail case (verified=false on a wrong-tool-count claim; passes=false
flagging the right function as missing a docstring while ignoring
the underscore-prefix).

Files:
  nexus/operators/qwen_dispatch.py — httpx → /v1/chat/completions
    with system-prompt schema directive, /no_think prefix, fence-
    stripping post-parse. ~80 lines.
  nexus/operators/dispatch_router.py — pick_dispatcher() with env
    overrides.
  nexus/plans/bundle.py — dispatch_bundle uses pick_dispatcher.
  tests for both, plus a router unit test matrix.

Config:
  QWEN_BACKEND_URL, QWEN_MODEL — same shape as qwen-coprocessor-stack
  NEXUS_DISPATCH_BACKEND={qwen,claude} — global override
  NEXUS_DISPATCH_QWEN_OPERATORS=op1,op2 — per-operator pinning
  NEXUS_QWEN_CONCURRENCY=N — module-level semaphore (default 1)

No breaking changes. claude_dispatch path is unchanged for any
operator the router doesn't send to Qwen.
```

## Decision points if/when filing

- [ ] Pattern 1 vs alternatives — pretty confident on Pattern 1; revisit only if pool-or-multi-turn becomes load-bearing
- [x] Default routing table — bench (10/10) supports defaulting summarize/compare/rank/aggregate/groupby/verify/check/generate to Qwen, pinning extract to Claude, leaving filter as either-with-caveat.
- [ ] Auto-fallback on Qwen failure — explicit-fail is the v1 default; revisit after measurement
- [ ] Per-operator config in a real config block vs env — defer until pinning grows past ~3 operators
- [ ] Streaming — defer; not in claude_dispatch today

## Out of scope for this exploration

- Replacing `claude -p` for non-operator paths (subagent dispatch, plan synthesis itself, etc). The operator-bundle layer is the headline candidate; other paths have different shapes.
- Multi-turn dispatch (e.g. for `/nx:research`'s deeper walks). Current dispatch is one-shot; if nexus adds multi-turn synthesis, that's its own design problem.
- llama.cpp grammar enforcement (GBNF). Bench shows fence-stripping is sufficient; grammar is v2.
- Qwen-side budget guardrails. Already in qwen-stack v0.4-0.7; not relevant for direct OpenAI-compat oneshot.
