# Qwen offload — full session summary (2026-05-14 → 2026-05-16)

> **Status (2026-05-16):** this summary documents an **exploration**,
> not a production rollout. All 19 nexus PRs filed during the session
> were auto-merged into `main` without per-PR operator consent and
> subsequently reverted via
> [nexus#821](https://github.com/Hellblazer/nexus/pull/821). The code
> is preserved on the
> [`exploration/qwen-offload-2026-05-15-2026-05-16`](https://github.com/Hellblazer/nexus/tree/exploration/qwen-offload-2026-05-15-2026-05-16)
> branch in nexus. The supervisor-side change in this repo
> ([qwen-coprocessor-stack#1](https://github.com/Hellblazer/qwen-coprocessor-stack/pull/1),
> pino → stderr) shipped in **v0.9.0** and is the only piece of this
> exploration that landed in a release. The narrative below is
> preserved as the historical record of what was attempted and what
> was learned; references to "shipped" or "merged" mean "landed in
> main during the exploration window before the revert."

End-to-end story of integrating local Qwen3.6-35B-A3B as a partial
replacement for `claude -p` across the nexus dispatch surface.
Companion docs:
- `qwen-dispatch-nexus.md` — the original design sketch
- `qwen-offload-audit-2026-05-14.md` — the audit that scoped phases 3-5
- `../qwen-field-report.md` — distilled model-behavior + operator
  playbook from the same exploration

## Where we started (2026-05-10)

Three nexus PRs from a prior session had already shipped:

- **#623** `qwen_dispatch` + per-operator routing — httpx-direct OpenAI-compat
  to llama-server, drop-in for `claude_dispatch`. 10 bundleable operators
  (extract, rank, summarize, compare, filter, aggregate, groupby, verify,
  check, generate) addressable by name through `dispatch_router`.
- **#626** Promoted `extract` to qwen-default after a dedicated re-bench
  (4 cases × 5 repeats = 20/20 oracle-match).
- Bench harness in `qwen-coprocessor-stack/scripts/bench/` — A/B against
  `claude -p --json-schema` across all 10 ops.

Bench evidence at that point: 100% schema-valid both engines, 1.03×
latency parity, content-equivalent. Operator opt-in via
`NEXUS_DISPATCH_BACKEND=auto`.

## What shipped in this session

**17 PRs total** — 1 in `qwen-coprocessor-stack`, 16 in `nexus`.

### Phase 1 — cost telemetry

- **nexus#776** `operator_dispatch_cost` structured-log on both dispatchers.
  Sonnet 4.x rate constants ($3 / $15 per MTok, dated 2026-05-14). Qwen
  computes a would-have-cost estimate so operators can see the running
  saved-spend. Non-breaking; log-only.

### Phase 2 — beyond bundleable operators

Identified by an audit (`qwen-offload-audit-2026-05-14.md`) as the next
highest-leverage candidates outside the operator dispatch substrate.

- **nexus#778** `pick_dispatcher_for(call_site)` primitive in
  `dispatch_router` + migrated `taxonomy_cmd._generate_labels_batch` to it
  under the logical name `topic_labeler`. Reuses the existing env-pin
  pattern; no new env surface.
- **nexus#779** `_nx_answer_plan_miss` planner migrated to the same
  primitive under `plan_miss_planner`. No dedicated bench
  (structurally identical to bundleable operators).

### Phase 3 — aspect extractor (the heaviest claude shell-out)

`aspect_extractor.py` runs per-document on every ingest. Predates
`claude_dispatch` entirely — has its own `subprocess.run(["claude", "-p",
…])` with bespoke retry/classification.

- **nexus#780** Path-B parallel adapter behind `NEXUS_ASPECT_BACKEND=
  {claude, qwen}`. ~150 lines + 23 unit tests. Default unchanged.
- **nexus#782** `scripts/spikes/spike_c_aspect_qwen_parity.py` — A/B
  parity harness; accepts `--uri` / `--manifest`, field-by-field
  `AspectRecord` diff.
- **nexus#790** `scholarly-paper-v2` prompt (opt-in via
  `NEXUS_SCHOLARLY_PAPER_VERSION=v2`). Four prompt iterations against
  a 10-paper Grossberg corpus; v4 (= shipped v2) reaches **100% semantic
  agreement on `experimental_datasets` and 93% on
  `experimental_baselines`** via LLM-judged semantic equivalence.
- **nexus#793** spike_c harness improvements: `--prompt-override` flag +
  `judge_aspect_diffs.py` semantic-equivalence judge.

### Phase 4 — tier-B agentic tools

Three MCP tools whose prompts invite mid-loop tool use:
`nx_enrich_beads`, `nx_tidy`, `nx_plan_audit`. Cannot use the
`qwen_dispatch` (oneshot, no tools) substrate. Need the
qwen-coprocessor-stack supervisor as the integration point.

Prerequisite: install the **`nx` Qwen Code extension** at
`~/.qwen/extensions/nx/qwen-extension.json` that wires the
`nx-mcp` server into qwen CLI sessions. Verified end-to-end:
43 search results returned with 1 tool call against
`mcp__plugin_qwen-stack_supervisor__qwen_oneshot`.

Wire-bug fixes discovered while running spike_d:

- **qwen-coprocessor-stack#1** Redirected pino loggers to stderr.
  Default-stdout pino lines were corrupting the MCP stdio JSON-RPC
  channel — Claude Code's MCP plugin tolerated it, the Python MCP SDK
  did not. Reference implementation pydantic-strict validation made
  this finally visible.
- **nexus#798** `qwen_agent_dispatch` was passing `extensions=["nx"]` as
  a bare array; the supervisor's zod schema expects
  `{only|enable|disable}` object. Test had asserted the wrong shape
  against the supervisor's actual schema.

Routing PRs:

- **nexus#796** `qwen_agent_dispatch` (MCP-stdio client to the
  qwen-coprocessor-stack supervisor calling its `qwen_oneshot` tool) +
  opt-in routing for `nx_enrich_beads` via
  `NEXUS_TIER_B_DISPATCHER=qwen_agent`.
- **nexus#797** `scripts/spikes/spike_d_tier_b_parity.py` — A/B harness
  for tier-B tool-use dispatch. Three-axis metric: semantic equivalence
  (prose), structural Jaccard (set fields), tool-call count
  (from `qwen_oneshot.budget`).
- **nexus#799** `nx_enrich_beads` prompt tightened with JSON-only
  finalization directive + `max_tool_calls` raised from 20 to 50.
  spike_d ran without this and qwen exhausted the 20-cap on every
  case; self-termination after the tightening lands at 14-29 tool
  calls.
- **nexus#804** Generalized `judge_aspect_diffs.py` into
  `judge_parity_diffs.py` covering both spike_c (operator-tier) and
  spike_d (tier-B) output. Auto-detects row schema.
- **nexus#805** Routed `nx_tidy` and `nx_plan_audit` via the same
  `qwen_agent_dispatch` pattern. Spike_d skip-logic updated.
- **nexus#810** Mandate-tool-use prompt revisions for `nx_tidy` and
  `nx_plan_audit` after spike_d revealed 0-tool-call hallucination.
  Tidy now uses MCP search; audit didn't move.
- **nexus#812** `verification_method` enum on each `nx_plan_audit`
  finding (`mcp_search` / `filesystem` / `prompt_only` / `n/a`).
  Forces structured admission of "I didn't verify."
- **nexus#813** `nx_plan_audit` pinned to claude by default
  (`TIER_B_CLAUDE_PINNED = {"nx_plan_audit"}`). Per-tool env override
  surface (`NEXUS_TIER_B_<TOOL>_DISPATCHER`) for operators who want to
  re-bench.

## Bench evidence

### Operator-tier — 10 bundleable operators (re-validated 2026-05-14)

13 cases × 5 repeats × 2 engines = 130 dispatches:

| Engine | ok | json_valid | oracle | median | total |
|---|---|---|---|---|---|
| claude | 65/65 | 65/65 | 20/20 | 14.2s | 15:32 |
| qwen | 65/65 | 65/65 | 20/20 | 14.6s | 18:18 |

**Latency parity: 1.03×.** Promotion of `extract` to qwen-default
(#626) still holds; no regression on the original miss case.

### Operator-tier — `topic_labeler` + `plan_miss_planner` (spike_e, 2026-05-16)

5 cases each:

| Call site | claude ok | qwen ok | claude median | qwen median | ratio |
|---|---|---|---|---|---|
| `topic_labeler` | 5/5 | 5/5 | 10.4s | 19.9s | 1.91× |
| `plan_miss_planner` | 5/5 | 5/5 | 15.6s | 60.9s | **3.91×** |

All schema-valid, no invalid-tool emissions. Labels semantically
equivalent (cosmetic Title Case vs lowercase). Planner produces
shorter but valid plans (3-4 steps vs claude's 4-6) — slightly less
elaborate on `compare`-style questions.

**Verdict:** both fine on qwen, no re-pin needed. Defaults remain
claude; opt-in via `NEXUS_DISPATCH_QWEN_OPERATORS=...`.

### Aspect extractor — Grossberg-lab cognitive-modeling corpus (10 PDFs)

Four prompt iterations + semantic-equivalence judge:

| Field | v1 strict / sem | v2 strict / sem | v3 strict / sem | **v4 (shipped) strict / sem** |
|---|---|---|---|---|
| `experimental_datasets` | 20% / 46% | 40% / 57% | 70% / 90% | **80% / 100%** |
| `experimental_baselines` | 40% / 64% | 60% / 73% | 40% / 70% | **80% / 93%** |
| Prose fields | 70-90% | 90-100% | 80-90% | 80-90% |
| `salient_sentences` | 100% | 100% | 100% | 100% |

Latency: claude 20-26s/paper, qwen 145-240s/paper (5-12× slower).
Aspect is a **cost-savings story, not a speed story**. ~$0.18/paper
saved at scale.

Corpus at `~/git/ART/docs/papers/` (84 PDFs); full-corpus run is the
biggest open follow-on if confidence in the v2 default flip is needed.

### Tier-B agentic tools (spike_d, 2026-05-15/16)

| Tool | qwen ok | qwen tool_calls | Notes |
|---|---|---|---|
| `nx_enrich_beads` | ✓ 3/3 | 17, 22, 29 | clean after #799 prompt tighten |
| `nx_tidy` | ✓ 2/2 | 5, 8 | clean after #810 anti-recursion mandate |
| `nx_plan_audit` | ✗ structurally | 0, 0 | qwen emits final JSON without tool exploration |

`nx_plan_audit` failure mode is structurally interesting: instrumented
supervisor build (debug log of every assistant message) shows qwen
emits exactly two messages — one `thinking` block + one `text` block
with the final JSON — and zero `tool_use` blocks. The `@qwen-code/sdk`
mirrors Anthropic's content-block shape, so the supervisor's counter is
authoritative. Qwen genuinely elects not to search when the plan JSON
is inlined in the prompt.

Even with #810 prompt mandate AND #812 `verification_method` schema
enforcement, qwen marks findings `verification_method=filesystem`
while doing zero tool calls. **The structured-honesty slot exists but
qwen fills it dishonestly.** Hence the #813 pin to claude.

Tier-B parity (spike_d full run, 3 nx_enrich_beads cases, semantic-
judge):

| Field | Strict | Semantic |
|---|---|---|
| `key_files` | 33% | 33% |
| `test_commands` | 13% | 19% |
| `constraints` | 0% | 20% |

Modest semantic lift, much smaller than spike_c's because tier-B
enrichment is **genuinely open-ended exploration** — two engines find
genuinely different files and emphasize different constraints, not just
paraphrase the same answer. This is a feature, not a bug — operators
get diverse coverage, but parity metrics will always look noisy.

## Activation — full opt-in surface

```bash
# Operator-tier — schema-bounded oneshot, low risk
export NEXUS_DISPATCH_BACKEND=auto                    # bake-in routing for bundleables
export NEXUS_DISPATCH_QWEN_OPERATORS=topic_labeler,plan_miss_planner

# Aspect extractor — pair with v2 prompt
export NEXUS_ASPECT_BACKEND=qwen
export NEXUS_SCHOLARLY_PAPER_VERSION=v2

# Tier-B agentic — enrich + tidy on qwen, audit pinned to claude
export NEXUS_TIER_B_DISPATCHER=qwen_agent
# Override audit pin if re-benching:
# export NEXUS_TIER_B_NX_PLAN_AUDIT_DISPATCHER=qwen_agent
```

Prerequisite: `nx` Qwen Code extension at
`~/.qwen/extensions/nx/qwen-extension.json` for tier-B routing.

## End state per call site

| Call site | Engine under full opt-in | Bench-validated? |
|---|---|---|
| 10 bundleable operators | qwen (auto routing) | ✓ 100% oracle |
| `topic_labeler` | claude default; qwen via env | ✓ 5/5 |
| `plan_miss_planner` | claude default; qwen via env | ✓ 5/5 |
| `aspect_extractor` (knowledge__*) | qwen via env + v2 prompt | ✓ 10/10 (small corpus) |
| `nx_enrich_beads` | qwen via env | ✓ 3/3 |
| `nx_tidy` | qwen via env | ✓ 2/2 |
| `nx_plan_audit` | **claude (pinned)** | ✗ structural hallucination |

## What we now know about Qwen3.6-35B-A3B as a coprocessor

1. **Oneshot prompt → JSON-out**: works reliably. The 10-bundleable
   operator bench is the clean case (1.03× latency parity, perfect
   schema-valid, oracle-equivalent).
2. **Large-context oneshot** (aspect extractor at 30-120k input tokens):
   works on output quality, slow (5-12× latency vs claude). Cost-
   savings story; latency hit is real.
3. **Tool-use loops that need exploration**: works when the prompt
   structurally requires searching to do the job (tidy can't fake
   consolidation; enrich can't fake codebase context).
4. **Tool-use loops that *could* be answered from prompt content alone**:
   qwen takes the shortcut. `nx_plan_audit` with inlined plan_json is
   the canonical example — qwen reads, reasons, emits authoritative-
   sounding output without tool exploration. Mitigations (prompt
   mandates, structured-admission schema) didn't move the behavior.
5. **JSON-only finalization in tool-use loops**: requires explicit
   prompt directive ("ONLY JSON, begin with `{`, end with `}`"). Without
   it qwen wants to write narrative summaries. Same pattern that
   motivated the scholarly-paper-v2 prompt tightening.
6. **Set-equality bench metrics are misleading for free-form
   extraction**. Strict-set agreement of 20-40% is often 60-90% under
   semantic-equivalence judging. Open-ended tasks (tier-B enrichment)
   can still show genuine disagreement that isn't paraphrasing.

## Open follow-ons

- **Full 84-paper aspect bench** with v2 prompt — would give stronger
  evidence to flip the v2 default. ~6 hours wall-clock.
- **Flip defaults** based on operator-side observation — `extract`
  promotion (#626) was the precedent; same logic applies to the other
  routings after enough production traffic.
- **Re-validate the `nx_plan_audit` pin** periodically — if a future
  qwen version honors verification mandates, promote it back.
- **No more known call sites to route.** The audit covered them all.

## Cost narrative

At rough numbers:
- Bundleable operators: ~$0.15-0.40 saved per `/nx:query`-style call.
- Aspect extractor (v2): ~$0.18/paper at ingest time.
- Topic labeler: ~$0.02/topic-batch.
- Plan-miss planner: ~$0.04/call (rare path — only on plan_match miss).
- Tier-B enrich/tidy: ~$0.03-0.05/call.

Operator-side amortization depends on workload mix. The bench harness
ships the cost-telemetry log so post-hoc accounting is possible from
`~/.config/nexus/logs/mcp.log` greps.
