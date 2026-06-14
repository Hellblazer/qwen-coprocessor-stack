<!-- SPDX-License-Identifier: MIT -->
# qwen_dispatch Operator Contract (RDR-008)

**Status:** published · **v4 pending nexus sign-off** (v2 added the `worktree` XOR `repo` worktree-spec
selector + the `invalid_worktree_spec` error; v3 (RDR-009) changed the response from `{patch}` to
`{artifacts: Artifact[]}`; **v4 (RDR-010) adds the optional `harvest` request field** —
`"patch"`(default)`|"value"|"both"` — additive, the response shape is unchanged — see
[#1174](https://github.com/Hellblazer/nexus/issues/1174)) · **Source RDR:** RDR-008, RDR-009, RDR-010
(accepted) · **Golden fixture:** [`fixtures/qwen-dispatch-shapes.json`](./fixtures/qwen-dispatch-shapes.json)

This is the **language-neutral** contract for `qwen_dispatch` — the agentic-dispatch
operator the qwen-coprocessor-stack supervisor exposes for an external engine
(e.g. **nexus**) to call. It mirrors how RDR-007 published the
[agent-dispatch contract](./agent-dispatch-contract.md): a spec an adopter **may**
conform to, **not** shared code. nexus owns its engine; this document states only
what the executor **provides** and **requires**.

It has two halves:

1. **Fixture-pinnable** — the request/response/error **shapes**, pinned by
   [`qwen-dispatch-shapes.json`](./fixtures/qwen-dispatch-shapes.json) and asserted
   on this host by `mcp-bridges/qwen-agent-server/tests/contract-conformance.test.ts`
   (the enforcement hook RDR-008 §Approach item 3 demands).
2. **Prose** — the **continuation requirements** and **one-shot semantics** an
   engine needs but which cannot be fixture-pinned. They are normative for any
   engine integrating this executor.

## The operator

`qwen_dispatch` runs **one** bounded agentic coding task to completion in a
caller-supplied worktree and returns an `AgentResult`. It is the `dispatch()`
contract of RDR-007 §4 lifted to an MCP tool boundary.

### Request

| key | type | req | meaning |
|-----|------|-----|---------|
| `prompt` | string | ✓ | the task/problem statement for the agent |
| `base_commit` | string | ✓ | base the patch is diffed against — **never `HEAD`** |
| `worktree` | string (abs path) | * | caller-supplied worktree the agent edits and `extractPatch` diffs |
| `repo` | string | * | `owner/name` — selects the executor-managed worktree strategy |
| `repo_url` | string | – | clone-source override for `repo`-mode (local path / non-github) |
| `max_turns` | int | – | turn budget (default 50) |
| `min_tokens` | int | – | per-turn output-token floor (default 16384) |
| `timeout_ms` | int | – | wall-clock cutoff in **milliseconds** (default 1800000) |
| `provider_id` | string | – | pin a declared agent-cli provider by id (overrides `agent_kind`) |
| `agent_kind` | string | – | dispatcher family to select (default `"qwen-local"`) |
| `harvest` | `"patch"`\|`"value"`\|`"both"` | – | what to harvest (RDR-010, default `"patch"`). `"value"` = the leaf's structured `finalMessage` as a `{kind:"value"}` artifact (non-code leaves); `"both"` = git-diff + value. Default keeps coding runs byte-identical. |

> **`*` Supply exactly ONE of `worktree` or `repo`** (the worktree strategy
> selector). `worktree` = caller-supplied (the caller owns lifecycle);
> `repo` = executor-managed (the `materialize.py` port — shared bare mirror +
> per-instance detached worktree at `base_commit`, cleaned up after the run).
> Neither or both → error `invalid_worktree_spec`.

> **`base_commit` is explicit at this boundary by design.** RDR-007's in-process
> `ExtractPatch` closure-captured the base; a closure can't cross the MCP
> boundary, so the base is a **required tool input** threaded to
> `ExtractPatch(worktree, baseCommit)`. It **always** diffs against `base_commit`,
> never `HEAD` — if the agent *commits* its edits, a bare `HEAD` diff is empty and
> the run scores a silent zero. `base_commit` is **not** carried on `AgentTask`
> (that shape is pinned by RDR-007's `agent-shapes.json` and is unchanged).

### Response — `AgentResult` (RDR-007, generalized by RDR-009)

A `qwen_dispatch` run is one agentic run, so its result **is** an `AgentResult`
([agent-shapes.json](./fixtures/agent-shapes.json)): `{artifacts, turns, outcome, cost}`.

> **RDR-009 wire change.** The single `patch: string` field is replaced by
> `artifacts: Artifact[]` — the typed harvest envelope. The `Artifact` union has
> exactly **four kinds**: `patch` | `value` | `entity` | `tier`. A `qwen_dispatch`
> coding run emits **one** `{kind:"patch", diff, base}` artifact (the git-diff
> harvester wrapping the source-only diff). This is **not** wire-compatible with
> the old `{patch}` shape; an engine reading `$stepN.patch` must migrate to
> `$stepN.artifacts` (filter `[?kind=='patch']`). The migration ships as one unit
> with this spec — there is no transition shape.

- `artifacts` — the run's typed work product. For a coding run: one
  `{kind:"patch", diff, base}` where `diff` is the **source-only** diff (test
  paths stripped; **contamination** is **host-internal**, NOT an artifact field —
  RDR-007 P4b) and `base` is the commit it was diffed against. The PUSH-channel
  kinds (`value`/`entity`/`tier`) are produced by other harvesters (the `/accept`
  path, RDR-009 Phase 2); a `qwen_dispatch` leaf does not emit them. `value` is the
  one PUSH kind reachable through the executor (a leaf's `finalMessage`, RDR-010);
  `entity`/`tier` are **orchestrator-produced** — their producer obligations are
  specified in the companion [harvest producer contract](./harvest-producer-contract.md)
  (RDR-011). The executor does not and will not emit `entity`/`tier` (one-shot invariant).
- `outcome: "timeout"` — the wall-clock cutoff fired; the patch artifact's `diff`
  is whatever the worktree held at the cutoff (possibly partial). **The worktree
  state is indeterminate.** A retry must run against a **fresh** worktree at
  `base_commit`, not the timed-out one — worktree lifecycle is the caller's (see below).
- `turns` — the real completed-turn count, including on a qwen-local **success**
  run (`PollResult.turns_completed` is the always-present live counter — bead
  **qwen-coprocessor-stack-j2r**).
- `cost` — `0` for free-local `qwen-local`.

### Errors

Structured envelope `{ "error": { "code": <code>, "message": <string> } }`:

| code | meaning | caller fix |
|------|---------|-----------|
| `no_provider` | no declared agent-cli provider matches the selector | declare one in `agent_providers` |
| `missing_agent_kind` | the selected provider declares no `agentKind` | add `agentKind` to its config |
| `unregistered_kind` | the provider's `agentKind` has no registered dispatcher | register a dispatcher for that kind |
| `invalid_worktree_spec` | not exactly one of `worktree` / `repo` supplied | supply exactly one |
| `shutting_down` | server is shutting down | retry later |

`missing_agent_kind` is deliberately distinct from `unregistered_kind` so a
misconfigured provider doesn't misdirect the caller to register a dispatcher.

## One-shot semantics — NORMATIVE for the engine

**This executor is strictly one-shot. A session reaching `idle` is TERMINAL** —
the agent finished its single self-contained task. There is **no resume path**.

> **nexus MUST NOT design a resume-the-executor continuation against
> `qwen_dispatch`.** Suspend/resume, choice injection, elicitation, and sampling
> are **engine** concerns. The executor neither suspends nor yields mid-run; it
> runs to a terminal `AgentOutcome` and returns. An engine that wants
> human/LLM choice at a node implements that in the engine and calls the executor
> for the leaf work — it does not ask the executor to pause.

### What the executor PROVIDES

- A single bounded agentic run → `AgentResult` (terminal outcome, source-only patch).
- Deterministic outcome classification identical to the RDR-007 spine
  (`classify-outcome`): `rc≠0`→`error`; `turns≥max`→`turn_limit`; `idle`/`complete`
  → `completed`; wall-clock cutoff → `timeout`.

### What the executor REQUIRES from the caller (engine)

- The **`base_commit`** + a worktree spec — exactly one of (selected on the wire,
  `src/worktree.ts`):
  - **`worktree`** (caller-supplied): the caller passes a ready worktree and owns
    its lifecycle; the executor only runs + extracts.
  - **`repo`** (executor-managed, `executorManagedWorktree` — the `materialize.py`
    port): a shared bare mirror + a per-instance detached worktree at
    `base_commit`, torn down after the run — for a host that wants isolation
    handled. `repo_url` overrides the clone source.
  Either way `base_commit` is **caller-supplied** (never inferred).
- A declared `agent-cli` provider (see registration ceremony).

## Registration ceremony

To make `qwen_dispatch` selectable, the host declares an **agent-cli provider**
and registers a **dispatcher** for its `agentKind`:

1. **Declare the provider** in `agent_providers` (config.json or
   `QWEN_AGENT_PROVIDERS`):
   ```json
   { "agent_providers": [ { "id": "qwen-coder-mac", "agentKind": "qwen-local" } ] }
   ```
   agent-cli providers are **not** model-endpoint backends; they carry no
   `url`/`model` and never enter the `backends` registry.
2. **Register the dispatcher** for the `agentKind`. The host builds a registry
   mapping `DispatcherKind → Dispatch` and registers `qwen-local` →
   `makeQwenSpawnDispatch(effects)`. Adding a new executor kind is a one-line
   registration + a new `DispatcherKind` member — not a rewrite.

> **Implementation note (load-bearing).** The dispatcher registry is constructed
> **per-call**: `base_commit` binds at dispatcher construction (so `extractPatch`
> always diffs against it), and the base is per-run. A future contributor must
> **not** "optimize" to a single shared registry — that would break the
> `base_commit` threading model.

For an engine, the analogous **operator-registration** step is wiring
`qwen_dispatch` as a typed operator in its plan/operator vocabulary, keyed to the
request/response shapes above.

## Conformance

- **Shapes** — `qwen-dispatch-shapes.json`, asserted by
  `tests/contract-conformance.test.ts` against the real `qwenDispatchInputShape`,
  `AgentResult`, and error-code set. Drift in any of the three fails the test.
- **One-shot prose** — not fixture-pinnable; this document is normative. The
  fixture pins `executor.oneShot`/`idleTerminal` as a machine-readable echo so an
  adopter's generator can assert the flag, but the **requirement** ("no resume
  path") is the prose above.

## Linked nexus proposal

The **proposed** operator-interface signature and registration ceremony for the
engine side live in the nexus proposal: see
[`nexus-dispatch-operator-proposal.md`](./nexus-dispatch-operator-proposal.md),
filed as [Hellblazer/nexus#1174](https://github.com/Hellblazer/nexus/issues/1174)
(**pending nexus sign-off** — agreed once nexus acks/amends; recorded on bead
**qwen-coprocessor-stack-pwa** and in T2).
