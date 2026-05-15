# Qwen offload — next-candidate audit (post-nexus#623/#626/#776)

**Date:** 2026-05-14
**Scope:** read-only survey of `claude -p` / `claude_dispatch`-shaped call
sites across `~/git/nexus/`, `qwen-coprocessor-stack/`, `~/.claude/plugins/`,
and the wider `~/git/` tree. Goal: rank additional Qwen offload candidates
beyond the 10 bundleable nexus operators already shipped.

The 10 bundleable nexus operators (`extract` / `rank` / `summarize` /
`compare` / `filter` / `aggregate` / `groupby` / `verify` / `check` /
`generate`) route through `qwen_dispatch` via `dispatch_router` under
`NEXUS_DISPATCH_BACKEND=auto`. This audit covers everything else.

## Top candidates

| # | Path | Shape | Schema | Precision | Volume | Score |
|---|------|-------|--------|-----------|--------|-------|
| 1 | `nexus/src/nexus/aspect_extractor.py:830, :1101` (`_invoke_once`, `_invoke_once_batch`) | oneshot subprocess | yes (JSON, app-side parse) | MEDIUM | **heavy** (per-document on ingest, batched N papers per call) | **highest** |
| 2 | `nexus/src/nexus/commands/taxonomy_cmd.py:1014` (`_generate_labels_batch` via `claude_dispatch`) | oneshot | yes (`_LABEL_SCHEMA`) | LOW (3-60 char labels, schema-clamped) | medium-heavy (batched 20/call across taxonomy) | very high |
| 3 | `nexus/src/nexus/mcp/core.py:3228` (`_nx_answer_plan_miss` planner via `claude_dispatch`) | oneshot | yes (`_PLANNER_SCHEMA`) | MEDIUM (wrong plan = wrong retrieval, but executed plan is host-verified) | medium (only on plan-match miss; gated) | high |
| 4 | `nexus/src/nexus/mcp/core.py:3897` (`nx_tidy`) | oneshot at boundary, agent loop inside | yes (`summary`+`actions`) | MEDIUM | light | medium |
| 5 | `nexus/src/nexus/mcp/core.py:3959` (`nx_enrich_beads`) | oneshot+agentic (searches codebase) | yes (`enriched_description`) | MEDIUM | medium | medium |
| 6 | `nexus/src/nexus/mcp/core.py:4017` (`nx_plan_audit`) | oneshot+agentic | yes (verdict/findings) | HIGH (audit failures hide real plan bugs) | light | medium-low |

### Rationale

**(1) `aspect_extractor`** — biggest miss from the v0.7 delegation report.
Does *not* go through `claude_dispatch`; uses its own
`subprocess.run(["claude","-p","--output-format","json"], input=prompt, ...)`
with `_retry_subprocess` / `_retry_subprocess_batch` retry/backoff.
Single-paper + batch-of-N-papers shapes, both oneshot, both
schema-constrained downstream by `_build_record`. Per-document on every
ingest — **the heaviest Claude shell-out in the codebase**. Adapter target:
re-implement `_invoke_once` / `_invoke_once_batch` on top of `qwen_dispatch`
(or the existing dispatcher with a router flag), then dual-bench on a
known paper corpus.

**(2) `taxonomy_cmd._generate_labels_batch`** — already lives on the
`claude_dispatch` substrate, so routing flip is trivial. Topic labels are
3-60 char strings with idx mapping; Qwen3.6 already aces the `generate`
operator at 20/20. Schema is bounded harder than most bundleable
operators. Volume scales with collection size. Likely a 1-line change in
`dispatch_router.py`'s per-operator pin list once the call is registered
as a routed operator.

**(3) `_nx_answer_plan_miss` planner** — inline planner emits
`{steps:[{tool, args}]}` with `_PLANNER_SCHEMA`. Schema-constrained,
oneshot, with built-in retry on `OperatorOutputError`. Host validates
emitted tools against `_ALLOWED_TOOLS`, so wrong-tool hallucinations are
caught. Exactly the "structured-decomposition" shape Qwen3.6 handled
well in the bench. Bench against the existing plan-miss corpus first.

**(4-6) `nx_tidy` / `nx_enrich_beads` / `nx_plan_audit`** — shipped via
RDR-080 P3 to replace the deprecated `knowledge-tidier` /
`plan-enricher` / `plan-auditor` agents. All oneshot at the dispatch
boundary but internally the prompt invites the subagent to call MCP
tools (search/store_get). That's a multi-turn agent loop hiding behind
a oneshot dispatch — see "Rejected" caveat below. Qwen3.6 with the
qwen-agent-server MCP bridge handles this, but it's untested at the
volumes these tools see. Bench needed against the bridge specifically.

## Honorable mentions

- `nexus/scripts/spikes/spike_b_rerank_prototype.py:69` — `claude_dispatch`
  for a "second-opinion" rerank score. Oneshot, schema-bounded. Spike,
  not production. If it productionizes, route via Qwen.
- `nexus/scripts/spikes/spike_a_check_stability.py` /
  `spike_a_groupby_stability.py` — stability spikes for already-bundleable
  operators. Not new candidates; covered by #623.
- `qwen-coprocessor-stack/scripts/bench/qwen_vs_claude.ts` — the bench
  harness itself, not a production call site.

## Rejected

- `nexus/src/nexus/operators/dispatch.py` — *is* the substrate. Already
  covered by the router.
- `nx/4.26.x/agents/*.md` plan-auditor / plan-enricher / knowledge-tidier
  definitions — explicit stubs that redirect to the corresponding MCP
  tools. Routing them is the same problem as candidates 4-6.
- `nexus/scripts/validate/0[1789]-*.py` — operator validation harnesses;
  reference `claude -p` in fixtures, not real call sites.
- `nexus/scripts/cron-rdr-audit.sh` / `bundle_sandbox_probe.py` — internal
  tooling, weekly cadence, negligible volume.
- `~/.claude/plugins/cache/claude-plugins-official/skill-creator/` —
  skill-creator's eval loop shells out to `claude -p` for skill description
  optimization, but it's running *the user's actual coding model* against
  a benchmark; correctness depends on the same model the user runs Claude
  Code under. Not an offload target.
- `mcp-bridges/qwen-agent-server/src/server.ts` — *is* the Qwen-side
  bridge. Same self-reference issue.
- `nexus/src/nexus/commands/hook.py` — references to `claude` are about
  Claude Code's hook protocol (stdin session id), not subprocess
  invocation. No call site.

**Key caveat:** outside `aspect_extractor` and `taxonomy_cmd`, almost every
remaining `claude_dispatch` caller (`nx_answer`, `nx_tidy`,
`nx_enrich_beads`, `nx_plan_audit`) wraps a prompt that *expects the
subagent to call MCP tools mid-prompt*. The bundleable operators
succeeded on Qwen precisely because they don't do that — the data is in
the prompt and the answer comes out. Tool-use-in-prompt is a different
regime, gated by the qwen-agent-server bridge's robustness.

## Recommended next step

**Bench `aspect_extractor` first.** Reasoning:

1. Single highest-volume Claude shell-out in the codebase.
2. Doesn't go through the existing `claude_dispatch` router, so a
   route-flag flip won't reach it — needs an adapter.
3. Pure oneshot prompt → JSON, no in-prompt tool use — matches the
   regime Qwen3.6 was already validated in.
4. Schema is well-defined and host-validated by `_build_record`.

Approach:

1. Build a one-shot adapter that swaps `subprocess.run(["claude","-p",...])`
   for `qwen_dispatch` behind a `NEXUS_ASPECT_BACKEND` env var.
2. Run the existing aspect-extraction corpus through both engines.
3. Compare `AspectRecord` field-by-field.
4. If parity holds, ship behind the env flag; flip default after a week
   of production traffic.

Likely cost win exceeds PR #623 because ingest volume dwarfs retrieval
volume. After aspect_extractor, `taxonomy_cmd` is a one-line router pin.
Only after both ship should the multi-turn `nx_*` tools (4-6) be benched,
and only against the qwen-agent-server MCP bridge with a
tool-use evaluation harness — not the simple oneshot bench.

## Key paths

- `nexus/src/nexus/aspect_extractor.py:830` (single), `:1101` (batch)
- `nexus/src/nexus/commands/taxonomy_cmd.py:1014`
- `nexus/src/nexus/mcp/core.py:3228` (planner), `:3897` (tidy),
  `:3959` (enrich), `:4017` (audit)
- `nexus/src/nexus/operators/dispatch_router.py:53` (where new pins land)
