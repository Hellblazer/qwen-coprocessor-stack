---
title: "Unified agent dispatch contract — one AgentProvider registry + one dispatch interface across Claude and Qwen"
id: RDR-007
type: Design
status: draft
priority: medium
author: hal
reviewed-by: self
created: 2026-06-13
related_issues: []
---

# RDR-007: Unified agent dispatch contract

> Revise during planning; lock at implementation.
> If wrong, abandon code and iterate RDR.

## Problem Statement

The stack already has **two working provider-agnostic spines** for running
work across Claude and Qwen, plus a third model-level router — but they live
at three different altitudes and none references the others. Routing
knowledge ("schema-synth never goes to an MLX backend", "no agentic on
coder-box") is scattered across ad-hoc boolean flags and prose `bd`
memories instead of one declarative, testable place.

If Qwen-coder is to do **useful coprocessor work** rather than just be
benched and offline-dispatched, the selection of *which provider runs a
task* needs to be a single auditable contract that all three callers share —
otherwise every new integration re-derives routing from scratch and the
tribal-knowledge exclusions silently rot.

## Context

Three routers exist today, each hand-rolling provider selection:

- **`chooseBackendByModality`** (`mcp-bridges/qwen-agent-server/src/backends.ts:547`)
  — model-endpoint altitude. Selects over `Backend[]` by
  modality → tier → capacity → health → weighted round-robin. The `Backend`
  interface (`src/types.ts:16`) already carries ~60% of a capability
  descriptor: `modality, tier, capacity, weight, ctx_size, roles[]`, plus the
  shipped exclusion flags `vision_only` and `no_agentic`. **But it describes
  model endpoints only — `claude -p` is not in the table at all.**

- **`pick_dispatcher_for`** (nexus, shipped 2026-05; see `bd` memory
  `qwen-offload-audit-2026-05-14`) — operator altitude. Already makes
  Claude and Qwen interchangeable for nexus operators via env switches
  (`NEXUS_ASPECT_BACKEND={claude,qwen}`, `NEXUS_TIER_B_DISPATCHER=qwen_agent`,
  `NEXUS_DISPATCH_QWEN_OPERATORS=…`). This **is** the unifying primitive,
  but it lives in a different repo and its descriptor is task-kind → backend.

- **`run_arm.py` spine** (`scripts/coding-eval/run_arm.py`) — task/run
  altitude. Already a verbatim provider-agnostic harness: `build_prompt`,
  `extract_source_patch(base=base_commit)`, `classify_outcome`,
  `write_prediction`, with `MAX_TURNS=40` / `MIN_COMPLETION_TOKENS=16384`
  shared across arms A (Qwen via supervisor), B (raw Qwen CLI), C
  (`claude -p`). Only invocation flags branch per provider.

Established constraints (from prior work):

- JSON-schema / GBNF synthesis works **only** on llama.cpp backends
  (coder-box); MLX backends ignore `response_format.json_schema`
  (`bd` memory `coprocessor-deployment-runbook`).
- Multimodal backends are serialized at the supervisor (RDR/PR #31).
- Qwen tier-B is ~4× Claude latency (~190s/case) but $0 and produces
  genuinely-different-but-valid output on open-ended tasks, not paraphrase
  noise (`qwen-dispatch-upstream-nexus-integration-shipped-2026-05`).
- Coder-Next-4bit ≈ 60% vs Claude 65% on SWE-bench Verified n=20 — real
  coding parity, latency-tolerant, free.

## Decision

Introduce **one capability registry (`select`) and one agentic dispatch
interface (`dispatch`)** for the **two in-repo routers**, as an internal
refactor that leaves all existing public call signatures unchanged.

> **Scope correction (gate, 2026-06-13).** The three-router framing in the
> Problem Statement is the *motivation*; the **deliverable of this RDR is the
> two in-repo routers only** — `chooseBackend*` (the model-endpoint family in
> `backends.ts`) and the `run_arm` spine (`scripts/coding-eval/`).
> `pick_dispatcher_for` lives in the **nexus repo** (zero references in this
> codebase; this RDR has no change authority over it). It is handled by
> *publishing the contract as a language-neutral spec nexus MAY adopt later*
> — not by rewriting it here. Until nexus adopts, the operator surface keeps
> its env-switch routing.

**1. `AgentProvider` descriptor** (superset of `Backend`; `Backend` is its
`kind:"model-endpoint"` projection):

```ts
interface AgentProvider {
  id: string;                            // "qwen-coder-box", "claude-sonnet"
  kind: "model-endpoint" | "agent-cli";  // pooled model endpoint vs claude -p / qwen_spawn
  modalities: Modality[];                // array; Backend.modality (singular) maps to [modality]
  strengths: TaskKind[];                 // advisory hint (soft)
  excludes: TaskKind[];                  // HARD exclusions over a CLOSED TaskKind enum (RF-2)
  latencyMult: number;                   // 1.0 Claude, ~4.0 Qwen tier-B
  costClass: "free-local" | "metered";
  // endpoint-only (kind=model-endpoint): url, tier, capacity, ctx_size, weight
}
```

`excludes` is the highest-value field: the scattered "never route X here"
rules become one declarative, testable list. **Note (gate):** for
model-endpoints, `excludes` *generalizes* the existing `vision_only` /
`no_agentic` flags, but `excludes: schemaSynth` on MLX backends is **net-new
enforcement** — today the MLX-no-schema rule is operator convention only
(`chat.ts` passes `response_format` unconditionally; nothing guards it). This
RDR makes it enforced for the first time.

**2. The `excludes` parity test needs a task classifier (gate Critical-4).**
A `classifyTask(opts) → TaskKind` function maps existing call-site signals to
a `TaskKind` — no new caller burden:

| signal at call site | `TaskKind` |
|---|---|
| `opts.json_schema` present | `schemaSynth` |
| agentic spawn (`qwen_spawn`/`qwen_oneshot`) | `agenticLoop` |
| `modality: embedding` / `rerank` | `embed` / `rerank` |
| plain chat | `chat` |

`select(pool, {taskKind})` then filters out any provider with `taskKind ∈
excludes`. The parity test asserts: for every call shape, no selected
provider excludes the classified `TaskKind`. `TaskKind` is a **closed enum**
(RF-2) so this assertion is exhaustive.

**Documented limitation (gate):** an explicit `opts.backend` pin bypasses
all filters — including `excludes` — exactly as it does today in
`chooseBackend` step 1 ("caller knows best"). So a caller that pins an MLX
backend *and* passes `json_schema` still gets the unguarded path. This is
pre-existing behavior, unchanged here; the `excludes` guard covers the
*unpinned* routing path, which is where the rule actually rots.

**3. `select()` — the one registry pass.** `chooseBackend` and
`chooseBackendByModality/Role` keep their **exact current public signatures**;
internally each projects `Backend → AgentProvider`, calls `select()` for the
filter+rank, and projects back. This is an **internal refactor, not an API
rewrite** — existing callers and the 6-step semantics (pool→tier→capacity→
health→round-robin→local-fallback) are preserved, now with the `excludes`
filter inserted. The eval arms' fixed per-arm pin is `select({id: pinnedArm})`
— a degenerate filter. The weighted-round-robin, env-switch, and fixed-pin
*selection semantics stay distinct*; `select()` unifies the *descriptor and
exclusion check*, not the ranking policy.

**4. `dispatch()` — agentic-altitude only.** The dispatch interface is scoped
to **`kind:"agent-cli"` providers** (the agentic loop: `claude -p`,
`qwen_spawn`). It is the `run_arm` spine generalized:

```ts
dispatch(task: AgentTask, provider: AgentProvider /* kind:"agent-cli" */): Promise<AgentResult>
// AgentTask   = { prompt, worktree, maxTurns, minTokens, timeout }
// AgentResult = { patch, turns, outcome, cost }
```

`kind:"model-endpoint"` providers (chat, schema-synth, embed, rerank) are
**selected** via `select()` but **invoked through their existing tool paths**
(`qwen_oneshot`, `qwen_embed`, `qwen_rerank`) — they do NOT implement
`dispatch()`. This avoids forcing a `patch`/`worktree` shape onto a result
that is a JSON object or an embedding vector (gate Critical-3). For
`qwen_spawn` (returns a `task_id`, polled via `qwen_poll`), the agent-cli
`dispatch()` implementation polls to completion internally before resolving —
matching the blocking semantics of `claude -p` and `run_arm`.

**Parity gate (gate Critical-1).** "Behavior identical to today" is asserted
against the named routing suite: **`backends.test.ts` (53) +
`routing-pool-vision.test.ts` (6) + `types.test.ts` (11) = 70 tests**, plus
`pool.test.ts`. (The earlier bare "70/70" was this sum; named here to remove
ambiguity.) New `excludes`/`classifyTask` behavior adds its own tests on top.

**Scope of THIS RDR:** the two-router consolidation only (descriptor +
`classifyTask` + `select()` refactor + agentic `dispatch()` + excludes-parity
test + published contract spec). **Deferred:** nexus adoption of the spec;
the in-loop coprocessor capability (a running Claude session delegating to
Qwen subagents) — both their own RDRs.

## Research Findings

The three open questions are resolved by source audit (2026-06-13). Full
detail in T2: `RDR-007-research-{01,02,03}-*`.

**RF-1 — Where the shared spine lives → language-neutral spec + golden
conformance fixtures (option c).** The `run_arm` spine is not one movable
thing; it splits into (A) *pure decision logic* — `build_prompt`,
`classify_outcome` (pure rule on returncode/turns), `gold_test_globs` —
which is language-neutral, and (B) *host-side effects* — `extract_source_patch`
/`_git_diff` (shells `git -C diff <base>`), `run_with_timeout`/`_kill_group`
(POSIX `os.killpg` process-group SIGKILL), `write_prediction` (file append) —
which **cannot be centralized**; they must run on whichever host runs the
agent. Decisive: Arm A **already** speaks raw MCP JSON-RPC 2.0 to the TS
supervisor in pure Python stdlib (`initialize` → `tools/call`), with no `mcp`
package dependency — a working cross-language wire boundary already exists.
So options (a) TS-source-of-truth and (b) Python-canonical both impose a
pointless cross-language RPC for effects each host already performs locally.
**(c)** is the only choice consistent with the existing architecture: pin the
contract *shape* (`AgentTask`/`AgentResult` JSON) + the *pure logic* (classify
rule, prompt render, exclusion predicate) with golden fixtures; each side owns
its own effects. Cost: a fixture suite.

**RF-2 — `TaskKind` → closed enum, mirroring `modality`.** The codebase
already encodes the hard-vs-soft distinction: `modality` is a *hard
capability → closed union*; `roles[]` is a *soft hint → deliberately open
free-form strings*. `excludes` is a hard safety constraint (same class as
modality); the parity test's value is the exhaustive assertion "no provider is
handed a task it excludes" — impossible over an unbounded set. So `TaskKind`
(the domain of `excludes`) **must be closed**. `strengths` may remain
advisory. No existing `TaskKind` enum — greenfield.

**RF-3 — Claude-as-`agent-cli` → uniform via optimistic-null health, no
capacity dimension, zero special-casing.** `chooseBackend` already treats
`health === null` (unprobed) as healthy-optimistic; only explicit `false`
excludes. `claude -p` is a metered remote API with no `/health` — it maps
exactly onto that convention (available until a call fails). `capacity`
(`fast`/`heavy`) is a local-model prompt-size heuristic, meaningless for a
single remote API, and already scoped model-endpoint-only in the
`AgentProvider` design. So agent-cli providers report `health=null` and skip
the capacity step; `select()` stays uniform across both `kind`s with no
branching.

## Consequences

- **Positive:** one auditable routing surface **for the in-repo routers**;
  scattered model-endpoint exclusion rules become testable and the
  MLX-no-schema rule becomes enforced (net-new); `claude -p` and the Qwen
  backends sit in the same registry for the first time; new **in-repo**
  provider additions become config, not code; the published contract spec
  unblocks both nexus adoption and the in-loop coprocessor RDR.
- **Negative / risk (gate-tracked):**
  1. **Cross-language spec drift** (RF-1) — the contract is a language-neutral
     spec, the silent-divergence class the stacked review gate exists to
     catch. Mitigation: golden conformance fixtures both hosts must pass.
  2. **Partial unification** — only 2 of 3 routers are consolidated here;
     nexus's `pick_dispatcher_for` keeps env-switch routing until it adopts
     the spec. The tribal-knowledge problem persists on the nexus operator
     surface until then. Accepted, explicitly scoped.
  3. **Config migration** — `Backend.modality` (singular) → `modalities[]`
     (array) is not a pure projection; the `Backend → AgentProvider`
     projection must normalize `modality` to `[modality]`. Existing
     `config.json` files are unchanged (projection happens in code).
  4. **Behavior-preservation** — asserted against the named routing suite
     (`backends.test.ts` 53 + `routing-pool-vision.test.ts` 6 +
     `types.test.ts` 11 = 70, plus `pool.test.ts`); the `select()` refactor
     must leave all 70 green, with new `excludes`/`classifyTask` tests added.

## References

- `bd` memories: `qwen-offload-audit-2026-05-14`,
  `qwen-dispatch-upstream-nexus-integration-shipped-2026-05`,
  `run-arm-spine-contract-40v3`, `coprocessor-deployment-runbook`.
- RDR-001 (supervisor + multi-backend routing), RDR-006 (eval harness / arms).
- Code: `src/backends.ts:547`, `src/types.ts:16`, `scripts/coding-eval/run_arm.py`.
