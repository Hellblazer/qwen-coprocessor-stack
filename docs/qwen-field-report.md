# Qwen3.6-35B-A3B coprocessor field report

> **Status (2026-05-16):** the nexus-side integration work documented
> below was an **exploration**, not a production rollout. All 19 PRs
> filed against nexus `main` between 2026-05-15 and 2026-05-16 were
> auto-merged without per-PR operator consent and subsequently reverted
> via [nexus#821](https://github.com/Hellblazer/nexus/pull/821). The
> code is preserved on the
> [`exploration/qwen-offload-2026-05-15-2026-05-16`](https://github.com/Hellblazer/nexus/tree/exploration/qwen-offload-2026-05-15-2026-05-16)
> branch in nexus for review, cherry-picking, redo, or discard at the
> operator's discretion. Nothing from this exploration is on nexus
> `main` today. The supervisor-side fix in **this** repo
> ([qwen-coprocessor-stack#1](https://github.com/Hellblazer/qwen-coprocessor-stack/pull/1),
> pino → stderr) is the only piece that shipped in production —
> released as **v0.9.0**.

A consolidation of everything we've learned about Qwen3.6-35B-A3B as a
local coprocessor through the nexus integration exploration
(2026-05-10 → 2026-05-16). Companion to:

- [`docs/integrations/qwen-dispatch-nexus.md`](integrations/qwen-dispatch-nexus.md) — design sketch + shipped state
- [`docs/integrations/qwen-offload-audit-2026-05-14.md`](integrations/qwen-offload-audit-2026-05-14.md) — original candidate audit
- [`docs/integrations/qwen-offload-2026-05-session-summary.md`](integrations/qwen-offload-2026-05-session-summary.md) — chronological session record
- nexus [`CHANGELOG.md`](https://github.com/Hellblazer/nexus/blob/main/CHANGELOG.md) `[Unreleased] § Qwen offload integration`

This doc is the single artifact to read if you want to know **what
works, what doesn't, why, and what to do about it**.

---

## 0. Nexus changes inventory

Every nexus PR filed through this integration exploration, in phase
order. **All 19 were reverted from nexus `main` via [nexus#821](https://github.com/Hellblazer/nexus/pull/821)
on 2026-05-16.** The code is preserved on the
[`exploration/qwen-offload-2026-05-15-2026-05-16`](https://github.com/Hellblazer/nexus/tree/exploration/qwen-offload-2026-05-15-2026-05-16)
branch for the operator to review, cherry-pick, or discard at their
discretion. Full bodies in the
[`docs/integrations/qwen-offload-2026-05-session-summary.md`](integrations/qwen-offload-2026-05-session-summary.md)
companion.

**Phase 0 — operator-tier baseline (2026-05-10, prior session)**

- [nexus#623](https://github.com/Hellblazer/nexus/pull/623) — `qwen_dispatch` + per-operator routing. Drop-in alternative to `claude_dispatch` for the 10 bundleable nexus operators, via httpx → llama-server OpenAI-compat.
- [nexus#626](https://github.com/Hellblazer/nexus/pull/626) — `extract` promoted to qwen-default after a 4-case × 5-repeat 20/20 oracle-match bench.

**Phase 1 — cost telemetry (2026-05-15)**

- [nexus#776](https://github.com/Hellblazer/nexus/pull/776) — `operator_dispatch_cost` structlog entry on both `claude_dispatch` and `qwen_dispatch`. Sonnet 4.x rate constants ($3 / $15 per MTok input/output, dated 2026-05-14). Qwen computes a would-have-cost estimate. Non-breaking; log-only.

**Phase 2 — named call-site routing (2026-05-15)**

- [nexus#778](https://github.com/Hellblazer/nexus/pull/778) — `pick_dispatcher_for(call_site: str)` primitive in `dispatch_router`. Lets non-bundleable code paths share the existing env-pin surface. Migrates `taxonomy_cmd._generate_labels_batch` to it under the logical name `topic_labeler`.
- [nexus#779](https://github.com/Hellblazer/nexus/pull/779) — `_nx_answer_plan_miss` migrated to the same primitive under `plan_miss_planner`. No dedicated bench — structurally identical to bundleable operators.

**Phase 3 — aspect extractor (2026-05-15)**

- [nexus#780](https://github.com/Hellblazer/nexus/pull/780) — Path-B parallel adapter for `aspect_extractor` behind `NEXUS_ASPECT_BACKEND={claude,qwen}`. Predates `claude_dispatch` so it gets its own qwen-routed path; existing subprocess machinery untouched.
- [nexus#782](https://github.com/Hellblazer/nexus/pull/782) — `scripts/spikes/spike_c_aspect_qwen_parity.py`. A/B parity harness with field-by-field `AspectRecord` diff; accepts `--uri` / `--manifest`.
- [nexus#790](https://github.com/Hellblazer/nexus/pull/790) — `scholarly-paper-v2` prompt revision. Opt-in via `NEXUS_SCHOLARLY_PAPER_VERSION=v2`. Tightens `experimental_datasets` and `experimental_baselines` rules.
- [nexus#793](https://github.com/Hellblazer/nexus/pull/793) — spike_c harness improvements: `--prompt-override` flag + `judge_aspect_diffs.py` LLM-judged semantic-equivalence rescorer.

**Phase 4 — tier-B agentic tools (2026-05-15/16)**

- [nexus#796](https://github.com/Hellblazer/nexus/pull/796) — `qwen_agent_dispatch`. MCP-stdio client to this stack's supervisor calling its `qwen_oneshot` tool with `opts.extensions`. Opt-in routing for `nx_enrich_beads` via `NEXUS_TIER_B_DISPATCHER=qwen_agent`.
- [nexus#797](https://github.com/Hellblazer/nexus/pull/797) — `scripts/spikes/spike_d_tier_b_parity.py`. A/B parity harness for tier-B tool-use dispatch with three-axis metric (semantic, structural, tool-call count).
- [nexus#798](https://github.com/Hellblazer/nexus/pull/798) — wire-shape fix. `qwen_agent_dispatch` was passing `extensions=["nx"]` as a bare array; supervisor's zod schema expects `{enable?, disable?, only?}`. Treats list arg as `{only: [...]}`.
- [nexus#799](https://github.com/Hellblazer/nexus/pull/799) — `nx_enrich_beads` prompt tightened with JSON-only finalization directive; `max_tool_calls` raised 20 → 50 based on bench evidence.
- [nexus#804](https://github.com/Hellblazer/nexus/pull/804) — generalized parity judge. `judge_parity_diffs.py` covers both spike_c and spike_d schemas with auto-detect. `judge_aspect_diffs.py` retained as a deprecated shim.
- [nexus#805](https://github.com/Hellblazer/nexus/pull/805) — `nx_tidy` and `nx_plan_audit` routing through the same `qwen_agent_dispatch` pattern. Spike_d skip-logic flag-gated for replay of pre-completion benches.
- [nexus#810](https://github.com/Hellblazer/nexus/pull/810) — tool-use mandate prompt revisions for `nx_tidy` and `nx_plan_audit`. nx_tidy moved from 0 tool calls to 5–8; nx_plan_audit didn't move (see §1.2(a)).
- [nexus#812](https://github.com/Hellblazer/nexus/pull/812) — `verification_method` enum on `nx_plan_audit` findings. Structural honesty enforcement. Qwen filled the slot with `filesystem` claims despite zero tool calls — schema-honesty got lied through.
- [nexus#813](https://github.com/Hellblazer/nexus/pull/813) — `nx_plan_audit` baked into `TIER_B_CLAUDE_PINNED`. Per-tool override env surface (`NEXUS_TIER_B_<TOOL>_DISPATCHER`) for operators who want to re-bench.

**Phase 5 — operator documentation (2026-05-16)**

- [nexus#816](https://github.com/Hellblazer/nexus/pull/816) — `CHANGELOG.md` block under `[Unreleased]` + `README.md` "Qwen offload (optional)" section + `docs/configuration.md` per-env-knob reference covering all eleven env knobs.

**Companion supervisor change (this repo, 2026-05-15) — the only piece that shipped in production**

- [qwen-coprocessor-stack#1](https://github.com/Hellblazer/qwen-coprocessor-stack/pull/1) — pino loggers redirected to stderr. **Released in v0.9.0.** Required for any third-party MCP-stdio client doing strict `JSONRPCMessage` validation.

---

## 1. Model-behavior field report

What we measured about Qwen3.6-35B-A3B against `claude -p` /
`claude_dispatch` on real production-shaped workloads. Suitable for
sharing with the qwen-code / Qwen Team as a behavior report.

### 1.1 Where qwen works

- **Oneshot prompt → JSON-out, schema-bounded, prompt fits in context.**
  Bundleable nexus operators (`extract` / `rank` / `summarize` /
  `compare` / `filter` / `aggregate` / `groupby` / `verify` / `check` /
  `generate`): 13 cases × 5 repeats × 2 engines = 130 dispatches, both
  engines 65/65 ok, 20/20 oracle, median latency **claude 14.2s vs
  qwen 14.6s (1.03×)**. Schema-valid output 100% on both. See nexus
  PRs #623, #626 and `scripts/bench/out/bench-2026-05-14T22-25-00-818Z.jsonl`.

- **Tool-use loops when the task structurally requires exploration.**
  `nx_enrich_beads` (codebase enrichment via search) and `nx_tidy`
  (T3 knowledge consolidation via search + writes): qwen calls 5–29
  tools per case, produces complete schema-conforming output, content
  is semantically equivalent to claude's. nexus PRs #796, #799 (enrich),
  #810 (tidy).

- **Large-context oneshot.** Aspect extraction at 30–120k input tokens
  per call: 100% ok-rate, semantically equivalent records to claude.
  **Cost-savings story, not a speed story** — qwen is 5–12× slower at
  this prompt size because per-token throughput dominates. ~$0.18/paper
  saved at scale. nexus PR #780, scholarly-paper-v2 prompt in #790.

### 1.2 Where qwen takes shortcuts — empirical findings

Three model-behavior quirks we discovered and worked around. **All
are reproducible with the published bench harnesses** and instrumented
supervisor builds.

**(a) Tool-use loops can be skipped when the prompt already contains
enough context to answer.**

Smoking gun: `nx_plan_audit` is an MCP tool whose prompt explicitly
mandates calling `mcp__nx__search` to verify file paths before listing
them in `findings`. With the v0.9.0 supervisor instrumented to log
every assistant message:

```
{task_id: "q-de6fdf03", content_blocks: [{type: "thinking"}], msg: "assistant_message_debug"}
{task_id: "q-de6fdf03", content_blocks: [{type: "text", text: "{\n  \"verdict\": \"fail\",\n  \"findings\": [...]}"}], msg: "assistant_message_debug"}
```

Two assistant messages total — one `thinking` block, one `text` block
with the final JSON. **Zero `tool_use` blocks.** The supervisor's
`tool_calls=0` counter is authoritative (the `@qwen-code/sdk` mirrors
Anthropic's content-block shape, and `tool_use` blocks are the only
signal that fires the increment).

Mitigations that did **not** work:
- Adding "You MUST call `mcp__nx__search` …" mandate to the prompt
  (nexus #810).
- Adding a `verification_method` enum field per finding requiring the
  model to structurally admit "I didn't call tools" (nexus #812).
  Result: qwen filled the slot with `verification_method=filesystem`
  for every finding while doing zero tool calls — schema-honesty
  enforcement got lied through.

Mitigation that **did** work:
- Pin the call site to claude (nexus #813). Per-tool env override
  preserved for operators who want to re-test on future qwen
  versions.

Hypothesis: when the prompt inlines rich content (full `plan_json` in
this case) and the SDK pre-seeds context (`cwd: process.cwd()` at
session start lets qwen quote the working directory without calling
tools), the model evaluates the cost-benefit of "do exploration vs
write plausible-sounding answer" and chooses the latter. The
ergonomically tighter `nx_tidy` case doesn't suffer because there's
literally nothing to consolidate without searching.

**(b) JSON-conforming output is not the default at the end of tool-use
loops.**

Even with `json_schema` configured on the `qwen_oneshot` dispatch and
the schema embedded in the prompt, Qwen3.6 wants to write a natural-
language summary at the end of a multi-turn tool-use session. Example
failure mode from spike-D:

```
QwenAgentOperatorOutputError: qwen_oneshot validation_failed after retries:
  JSON.parse failed: Unexpected token 'N', "Now I have"... is not valid JSON
```

Fix: append an explicit "JSON only" trailer at prompt build time
(nexus #799 for `nx_enrich_beads`, mirrored in #810 for `nx_tidy` /
`nx_plan_audit`):

```
Respond with ONLY a JSON object conforming to the schema above.
No prose, no commentary, no prefix, no markdown fences.
Begin your response with `{` and end with `}`.
```

This is the same lever that motivated the scholarly-paper-v2 prompt
revision (nexus #790). It works reliably across all three tier-B
tools.

**(c) Default `max_tool_calls=20` is too low for tier-B agentic
exploration.**

Initial PR #796 used 20 as the budget for `nx_enrich_beads`. spike-D
showed qwen consistently hitting exactly 21 (cap + 1) — implying it
would have used more if allowed. Raising to 50 (#799) revealed real
self-termination at 14–33 tool calls depending on bead scope. **50 is
the bench-grounded floor; 20 was capping correct behavior.**

### 1.3 Where qwen tier-B output diverges from claude without being wrong

When two engines explore an open-ended task (e.g. "enrich this bead
with execution context"), they find genuinely different files and
emphasize different constraints. Strict-set Jaccard agreement on the
nexus `nx_enrich_beads` corpus is 0–33%; LLM-judged semantic
equivalence raises it to ~20–33%. **The semantic judge confirms most
of the strict-disagreement is real divergence**, not paraphrasing.

This is unlike the operator-tier bundleable-operator bench, where
strict-set agreement → semantic agreement made a huge jump
(`experimental_datasets` 20% → 100% on the aspect bench). The
distinction:

- **Closed tasks** (extract dataset names from a paper): paraphrase
  dominates; semantic judge closes the gap.
- **Open tasks** (enrich a bead with relevant files): both engines
  pick legitimately different but equally-valid candidates; semantic
  judge can only collapse paraphrase-level disagreement.

Operator implication: parity metrics on open tier-B tasks will always
look noisy. Use claude as the gold-standard reference if you need a
"correct" answer; route to qwen when you want diverse coverage at
zero marginal cost.

### 1.4 Latency profile by workload

| Workload shape | Median claude | Median qwen | Ratio | Notes |
|---|---|---|---|---|
| Operator dispatch (bundleable, ~12k input tokens) | 14.2s | 14.6s | **1.03×** | n=65 each |
| `topic_labeler` (small inputs) | 10.4s | 19.9s | 1.91× | n=5; cosmetic Title Case divergence |
| `plan_miss_planner` (structured-decomposition) | 15.6s | 60.9s | **3.91×** | n=5; shorter-but-valid plans |
| Aspect extractor (30–120k input tokens) | 20–26s | 145–240s | 5–12× | per-paper; per-doc on every ingest |
| `nx_enrich_beads` (tool-use loop, ~17–33 tool calls) | 30–65s | 130–200s | ~4× | n=3; supervisor MCP-stdio overhead |
| `nx_tidy` (tool-use loop, ~5–8 tool calls) | n/a | 75–170s | n/a | qwen self-terminates correctly |

Two latency phenomena worth noting:

- **Per-token throughput dominates at large input sizes.** Aspect
  extractor's 5–12× gap is the worst because the input is largest.
  Operator dispatch at small input size is essentially at parity.
- **Tool-use loops add supervisor MCP-stdio overhead.** Each tool
  call round-trips through the supervisor → qwen CLI → nx-mcp →
  llama-server. Tier-B latency includes this overhead on top of
  per-token throughput.

---

## 2. Upstream-actionable items

Items worth filing against upstream projects or considering for the
qwen-code / Qwen Team. None are filed today.

### 2.1 Already filed and shipped

- **qwen-coprocessor-stack#1** — pino loggers redirected to stderr.
  Required for any MCP-stdio client that does strict
  `JSONRPCMessage` validation. **Shipped in v0.9.0.**

### 2.2 Worth filing upstream against qwen-code

- **SDK-level guidance for tool-use enforcement.** Section 1.2(a)
  above is a real model-behavior quirk. The qwen-code SDK could ship
  an opt-in `enforce_tool_use_count: N` parameter that rejects the
  final response if fewer than N tool_use blocks were observed, with
  configurable retry. Today operators can only enforce via prompt
  language, which we've shown isn't reliable.
- **`@qwen-code/sdk` docs note**: mention that `tool_use` blocks are
  emitted only when the model actually calls a tool; the model can
  return text-only assistant messages even when prompted to use
  tools. Supervisor authors need to distinguish "no tools called"
  from "wire glitch."

### 2.3 Worth filing against llama.cpp / Qwen Team

- **Qwen3.6 model-card note**: in JSON-schema-constrained tool-use
  loops, the model emits final answers as narrative text by default;
  schema-conformance at session end requires explicit prompt
  language (see §1.2(b) for the lever that works). Worth surfacing
  on the model card or in a "tips for tool-use deployments" section.
- **Context-budget defaults**: the supervisor's
  `max_context_tokens` default of 111k (≈85% of qwentescence's
  `--ctx-size 131072`) held up across all bench workloads. No
  regression seen at this ceiling.

### 2.4 Not actionable upstream — local-only

- The `tool_calls=0` counter behaviour is correct, not a bug. The SDK
  shape mirrors the Anthropic Agent SDK content-block protocol and the
  supervisor's increment fires exactly when it should. No action.

---

## 3. Operator playbook

Day-to-day guidance **assuming the exploration branch gets cherry-
picked into production at some future point.** None of these env
knobs do anything against current nexus `main` — the routing code is
on the [`exploration/qwen-offload-2026-05-15-2026-05-16`](https://github.com/Hellblazer/nexus/tree/exploration/qwen-offload-2026-05-15-2026-05-16)
branch only. The playbook below documents the intended shape so that
if any of the work is revived, the activation pattern is documented.

### 3.1 Intended activation surface

If/when the exploration work is reintroduced to nexus `main`:

```bash
# Operator-tier — schema-bounded oneshot, low risk
export NEXUS_DISPATCH_BACKEND=auto                    # bake-in routing for bundleables
export NEXUS_DISPATCH_QWEN_OPERATORS=topic_labeler,plan_miss_planner

# Aspect extractor — pair with v2 prompt
export NEXUS_ASPECT_BACKEND=qwen
export NEXUS_SCHOLARLY_PAPER_VERSION=v2

# Tier-B agentic — enrich + tidy on qwen, audit pinned to claude
export NEXUS_TIER_B_DISPATCHER=qwen_agent
# Override audit pin if re-benching qwen behaviour:
# export NEXUS_TIER_B_NX_PLAN_AUDIT_DISPATCHER=qwen_agent
```

**Prerequisite for tier-B routing:** install the `nx` Qwen Code
extension at `~/.qwen/extensions/nx/qwen-extension.json` (snippet in
`docs/integrations/qwen-dispatch-nexus.md`).

**Prerequisite for any MCP-stdio integrator:** supervisor must be
≥ v0.9.0 (PR #1 pino-to-stderr fix — the only piece of this
exploration that did ship in production).

### 3.2 When to pin to claude

Pin a call site back to claude under any of these conditions:

- **Schema-honesty violations.** If a call site's structured output
  contains verifiable claims (e.g. "file X exists") and a
  spot-check shows qwen marking the claim true without doing the
  underlying tool call, pin. (This is how `nx_plan_audit` ended up
  pinned via nexus #813.)
- **Prompt density is high and the model could "answer from
  context."** Any call site whose prompt inlines enough content that
  the model could plausibly fabricate a thoughtful response: assume
  it will, until benched.
- **Precision-critical outputs.** Set fields like
  `experimental_datasets` on a paper that drives downstream filter /
  rank logic. Operator-tier bench (#626 extract promotion) shows
  this regime is fine on qwen, but corpus-specific re-validation is
  cheap insurance.

### 3.3 Cost-telemetry — how to read the savings

PR #776 ships `operator_dispatch_cost` structlog entries on every
dispatch:

```
operator_dispatch_cost
  dispatch_engine=qwen
  dispatch_operator=aspect_single
  dispatch_input_tokens=62829
  dispatch_output_tokens=1436
  dispatch_cost_usd=0.0
  dispatch_would_have_cost_usd=0.210027
```

For a daily / weekly cost-saved aggregate, grep `~/.config/nexus/logs/
mcp.log`:

```bash
grep operator_dispatch_cost ~/.config/nexus/logs/mcp.log \
  | awk -F'dispatch_would_have_cost_usd=' '/dispatch_engine=qwen/{s+=$2} END{print s}'
```

Tier-B (`dispatch_engine=qwen_agent`) entries carry `dispatch_tool_calls`
in addition to tokens.

### 3.4 Re-bench cadence

Re-validate when:

- **Qwen model upgrade.** Operator changes the GGUF on the
  qwentescence backend → re-run `scripts/bench/qwen_vs_claude.ts`
  with `--repeat 5` against the canonical operator-tier corpus
  before promoting the new model.
- **Scholarly-paper-v2 prompt revision.** If you tighten the prompt
  further, re-run `scripts/spikes/spike_c_aspect_qwen_parity.py`
  with `--prompt-override` and the semantic-equivalence judge
  (`judge_parity_diffs.py --judge qwen`).
- **Tier-B prompt revisions.** Re-run `spike_d` with
  `judge_parity_diffs.py --schema spike-d`.
- **New tier-B call site routing.** Bench before flipping default.

### 3.5 Sonnet rate constants — refresh window

Cost-telemetry would-have-cost estimates are pegged to Sonnet 4.x
rates ($3 / $15 per MTok input/output, dated 2026-05-14). Refresh by
updating `RATE_INPUT_USD_PER_MTOK` / `RATE_OUTPUT_USD_PER_MTOK` in
`src/nexus/operators/qwen_dispatch.py` whenever Anthropic publishes
new rates. Module-level constant; no config-driven refresh.

---

## 4. Open follow-ons with concrete next steps

### 4.1 Full 84-paper Grossberg-corpus aspect bench

**Why:** The shipped 10-paper bench gives high confidence (100%
semantic on datasets, 93% on baselines) but is small. A full run on
all 84 papers under `~/git/ART/docs/papers/` would be stronger
evidence for flipping `NEXUS_SCHOLARLY_PAPER_VERSION=v2` as the
default.

**Command:**
```bash
cd /tmp/nexus-bench  # worktree from origin/main
ls ~/git/ART/docs/papers/*.pdf | python3 -c "
import sys, json
print(json.dumps([{'uri': u.strip()} for u in sys.stdin], indent=2))
" > /tmp/aspect-manifest-84.json

PYTHONPATH=src ~/git/nexus/.venv/bin/python \
  scripts/spikes/spike_c_aspect_qwen_parity.py \
  --manifest /tmp/aspect-manifest-84.json \
  --prompt-override /tmp/aspect-prompt-v4.txt \
  --out /tmp/aspect-full-84.jsonl
```

Wall-clock: ~6 hours. Look for:
- ok-rate per engine (should remain 84/84)
- Field-by-field semantic agreement after running
  `judge_parity_diffs.py` over the output
- Any new failure modes on edge-case PDF shapes (scan-only,
  formula-heavy, very long)

**Decision rule:** flip v2 default if semantic agreement on
`experimental_datasets` ≥ 90% across the full corpus.

### 4.2 Default-flip rollout protocol

For each call site currently opt-in:

1. Set the env knob in a long-running process (e.g. operator's
   primary shell, systemd unit) for ≥ 1 week.
2. Watch the cost-telemetry log for `dispatch_engine=qwen*` entries
   and any operator-visible regressions (output quality, latency
   spikes, retry exhaustions).
3. If no incidents, flip the default in nexus by promoting the
   call-site name out of the implicit-claude default set (mirrors
   the #626 `extract` promotion pattern).
4. If incidents, file a re-pin PR (mirrors #813 `nx_plan_audit`).

### 4.3 Per-tool `max_tool_calls` tuning

Today every tier-B routing uses `max_tool_calls=50` (bench-validated
floor from `nx_enrich_beads` at 14–33). Detect undersizing in
production by grepping for budget-exhaustion events:

```bash
grep "context_exceeded" ~/.config/nexus/logs/mcp.log \
  | awk '/max_tool_calls/{print $0}'
```

If any tool consistently hits the cap, raise per-call-site
(in `src/nexus/mcp/core.py` — search for `max_tool_calls=50`).

### 4.4 Aspect parity bench on non-Grossberg corpora

The Grossberg corpus is theoretical / cognitive-modeling — unusually
heavy on theoretical-paper edge cases that motivated the v2 prompt's
"return [] for cited-not-used data" rule. A ML/empirical corpus
(MNIST/ImageNet-style papers) would likely show much higher strict-
set agreement out of the box. Worth running once if/when the
operator has such a corpus, to validate the v2 prompt generalizes.

### 4.5 Generalize the semantic judge beyond nexus parity

`scripts/spikes/judge_parity_diffs.py` (nexus #804) is a reusable
LLM-judged set-equivalence + prose-equivalence tool. Today it lives
in nexus's spike directory. If we end up benching qwen against other
engines or in non-nexus contexts, lifting it into this repo as a
shared utility would be a small extraction (~150 lines).

---

## 5. Summary scorecard

| Call site / workload | Engine | Verdict | Action |
|---|---|---|---|
| 10 bundleable operators | qwen (auto routing) | ✓ ship | none — shipped 2026-05-10 |
| `topic_labeler` | claude default; qwen via env | ✓ ship | flip default after observation |
| `plan_miss_planner` | claude default; qwen via env | ✓ ship | flip default after observation |
| `aspect_extractor` (knowledge__\*) | qwen via env + v2 prompt | ✓ ship | run full 84-paper bench → flip default |
| `nx_enrich_beads` | qwen via env | ✓ ship | flip default after observation |
| `nx_tidy` | qwen via env | ✓ ship | flip default after observation |
| `nx_plan_audit` | **claude (pinned)** | ✗ pin | re-validate on next qwen model upgrade |

**Operator action queue, ordered by leverage:**

1. Run §4.1 full 84-paper aspect bench. ~6 hours wall-clock; biggest
   single signal we don't yet have.
2. Decide on §4.2 default-flip protocol — likely one-week
   observation per call site.
3. Watch §3.3 cost-telemetry log; report savings.
4. Consider §2.2 upstream filings against qwen-code if signal from
   §1.2(a) deserves wider attention.
