# qwen_dispatch — informal upstream nexus design sketch

**Status:** SHIPPED. Upstream nexus PRs:

**Phase 1 — bundleable operators (2026-05-10):**
- **nexus#623** (initial qwen_dispatch + per-operator routing) — merged 2026-05-10T00:31Z
- **nexus#626** (promote `extract` to qwen-default + conftest env isolation) — merged 2026-05-10T01:26Z

**Phase 2 — cost telemetry (2026-05-15):**
- **nexus#776** (`operator_dispatch_cost` structured log on both dispatchers; qwen computes would-have-cost via Sonnet 4.x rate constants dated 2026-05-14) — merged 2026-05-15T02:02Z

**Phase 3 — beyond bundleable operators (2026-05-15, audit at `docs/integrations/qwen-offload-audit-2026-05-14.md`):**
- **nexus#778** (named-call-site primitive `pick_dispatcher_for(call_site)` + `topic_labeler` migration) — merged 2026-05-15T02:43Z
- **nexus#779** (`plan_miss_planner` route-flip — no dedicated bench, structurally identical to bundleable operators) — merged 2026-05-15T02:51Z
- **nexus#780** (`aspect_extractor` Path B parallel adapter behind `NEXUS_ASPECT_BACKEND={claude,qwen}`) — merged 2026-05-15T03:02Z
- **nexus#782** (`scripts/spikes/spike_c_aspect_qwen_parity.py` A/B parity harness — accepts `--uri` / `--manifest`, field-by-field `AspectRecord` diff) — merged 2026-05-15T03:19Z
- **nexus#790** (`scholarly-paper-v2` prompt — opt-in via `NEXUS_SCHOLARLY_PAPER_VERSION=v2`; tightens dataset/baseline definitions: theoretical papers return [] for cited prior data; ablation variants are NOT baselines) — merged 2026-05-15T15:08Z
- **nexus#793** (harness improvements: `--prompt-override` flag for spike_c + `judge_aspect_diffs.py` LLM-judged semantic-equivalence metric) — merged 2026-05-15

### Aspect bench results — 10-paper Grossberg corpus (`~/git/ART/docs/papers/`)

Four prompt iterations + semantic-equivalence judge (qwen self-judging on diff items, ~$0.10/run):

| Field | v1 strict / sem | v2 strict / sem | v3 strict / sem | **v4 strict / sem** |
|---|---|---|---|---|
| `experimental_datasets` | 20% / 46% | 40% / 57% | 70% / 90% | **80% / 100%** |
| `experimental_baselines` | 40% / 64% | 60% / 73% | 40% / 70% | **80% / 93%** |
| Prose fields | 70-90% | 90-100% | 80-90% | 80-90% |
| Salient sentences | 100% | 100% | 100% | 100% |

v4 (the shipped scholarly-paper-v2) reaches **100% semantic / 80% strict** on datasets and **93% / 80%** on baselines. Remaining gaps are pure paraphrase noise the judge correctly resolves.

Latency: claude 20-26s/paper, qwen 145-240s/paper (5-12× slower — much wider than the operator bench's 1.03× because aspect prompts run 30-120k input tokens vs the operator bench's ~12k). Cost saving: ~$0.18/paper. **The aspect offload story is cost-savings, not latency.**

### To activate Phase 3

```bash
# Trivial route-flips (low risk — schema-bounded, host-validated):
export NEXUS_DISPATCH_QWEN_OPERATORS=topic_labeler,plan_miss_planner

# Aspect adapter (opt-in; pair with v2 prompt for best results):
export NEXUS_ASPECT_BACKEND=qwen
export NEXUS_SCHOLARLY_PAPER_VERSION=v2

# Tier-B agentic tools (all three wired: nx_enrich_beads via #796/#799, nx_tidy + nx_plan_audit via #805):
export NEXUS_TIER_B_DISPATCHER=qwen_agent
```

### Tier-B prerequisite — `nx` qwen extension

The qwen-agent-server supervisor reaches the nexus MCP surface
through a Qwen Code **extension**. Install once per operator
workstation:

```bash
mkdir -p ~/.qwen/extensions/nx
cat > ~/.qwen/extensions/nx/qwen-extension.json <<'JSON'
{
  "name": "nx",
  "version": "0.1.0",
  "description": "Nexus MCP server — search, query, memory, store, catalog.",
  "mcpServers": {
    "nx": {
      "command": "nx-mcp"
    }
  }
}
JSON
```

(`nx-mcp` is the console script shipped by the `nexus` Python
package; if it's not on PATH, use the absolute venv path
`~/git/nexus/.venv/bin/nx-mcp`.)

Then reload the supervisor's installed-extensions cache and verify:

```bash
# Via the slash command if available:
/qwen-stack:extensions
# Or via MCP tool from any Claude Code session:
#   mcp__plugin_qwen-stack_supervisor__qwen_reload_extensions
#   mcp__plugin_qwen-stack_supervisor__qwen_extensions
```

The supervisor should report `{name: "nx", enabled_user: true,
mcp_servers: ["nx"]}`. Smoke-test by spawning a qwen session with
`extensions: {only: ["nx"]}` and asking it to call the nx
`search` tool — successful end-to-end run was verified
2026-05-15 with 43 search results returned and 1 tool call.

### Aspect bench corpus

For the deferred aspect parity run: `~/git/ART/docs/papers/` (84 PDFs,
Grossberg-lab cognitive-modeling literature). Invocation will be:

```bash
cd ~/git/nexus
python scripts/spikes/spike_c_aspect_qwen_parity.py \
    --uri ~/git/ART/docs/papers/*.pdf \
    --limit 10 \
    --out /tmp/aspect-parity.jsonl
```

(Adjust `--limit` based on appetite; full 84 papers × 2 engines ≈ 50-90
minutes wall-clock at single-paper invocation. The harness also supports
the batch path; check its `--help` when running.)

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

### Full 10-operator re-validation 2026-05-14

```bash
npm run bench -- --repeat 5 --timeout-ms 180000
```

13 cases × 5 repeats × 2 engines = 130 dispatches against qwentescence
(qwen3.6-35b-a3b):

| Engine | ok | json_valid | oracle | median | total |
|---|---|---|---|---|---|
| claude | 65/65 | 65/65 | 20/20 | 14.2s | 15:32 |
| qwen   | 65/65 | 65/65 | 20/20 | 14.6s | 18:18 |

**Clean sweep across all 10 operators.** Latency parity tightened from
2026-05-09 (1.36×) to 1.03× — Qwen median is 0.4s slower than Claude.
Likely a combination of prefix-cache hits across repeats and a warmer
qwentescence backend. Run output:
`scripts/bench/out/bench-2026-05-14T22-25-00-818Z.jsonl`.

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
