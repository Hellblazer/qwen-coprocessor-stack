<!-- SPDX-License-Identifier: MIT -->
# qwen_dispatch Operator Contract (RDR-008)

**Status:** published · **Source RDR:** RDR-008 (accepted) · **Golden fixture:** [`fixtures/qwen-dispatch-shapes.json`](./fixtures/qwen-dispatch-shapes.json)

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
| `worktree` | string (abs path) | ✓ | the worktree the agent edits and `extractPatch` diffs |
| `base_commit` | string | ✓ | base the patch is diffed against — **never `HEAD`** |
| `max_turns` | int | – | turn budget (default 50) |
| `min_tokens` | int | – | per-turn output-token floor (default 16384) |
| `timeout_ms` | int | – | wall-clock cutoff in **milliseconds** (default 1800000) |
| `provider_id` | string | – | pin a declared agent-cli provider by id (overrides `agent_kind`) |
| `agent_kind` | string | – | dispatcher family to select (default `"qwen-local"`) |

> **`base_commit` is explicit at this boundary by design.** RDR-007's in-process
> `ExtractPatch` closure-captured the base; a closure can't cross the MCP
> boundary, so the base is a **required tool input** threaded to
> `ExtractPatch(worktree, baseCommit)`. It **always** diffs against `base_commit`,
> never `HEAD` — if the agent *commits* its edits, a bare `HEAD` diff is empty and
> the run scores a silent zero. `base_commit` is **not** carried on `AgentTask`
> (that shape is pinned by RDR-007's `agent-shapes.json` and is unchanged).

### Response — `AgentResult` (reused verbatim from RDR-007)

A `qwen_dispatch` run is one agentic run, so its result **is** an `AgentResult`
([agent-shapes.json](./fixtures/agent-shapes.json)): `{patch, turns, outcome, cost}`.
No new fields.

- `patch` — **source-only** diff (test paths stripped). **Contamination** (a patch
  touching test files) is **host-internal**, NOT a field of `AgentResult`
  (RDR-007 P4b).
- `turns` — **`0` on a qwen-local success run today.** The supervisor's success
  poll carries no turn count (`PollResult.last_known` is populated only on the
  error path). Tracked by **qwen-coprocessor-stack-j2r**; until it lands, an
  adopter must treat `turns` as `0`-on-success, not a meaningful count.
- `cost` — `0` for free-local `qwen-local`.

### Errors

Structured envelope `{ "error": { "code": <code>, "message": <string> } }`:

| code | meaning | caller fix |
|------|---------|-----------|
| `no_provider` | no declared agent-cli provider matches the selector | declare one in `agent_providers` |
| `missing_agent_kind` | the selected provider declares no `agentKind` | add `agentKind` to its config |
| `unregistered_kind` | the provider's `agentKind` has no registered dispatcher | register a dispatcher for that kind |
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

- A ready **worktree** + the **`base_commit`** for it. Worktree lifecycle
  (create/cleanup) is the **caller's** — the default strategy is "caller-supplied
  worktree" (the executor only runs + extracts). An executor-managed strategy (a
  port of the eval harness's `materialize.py` mirror+detached-worktree mechanics)
  is a host-internal fast-follow, not part of this contract.
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

The agreed operator-interface signature and registration ceremony for the engine
side live in the nexus proposal: see
[`nexus-dispatch-operator-proposal.md`](./nexus-dispatch-operator-proposal.md),
filed as [Hellblazer/nexus#1174](https://github.com/Hellblazer/nexus/issues/1174)
(also recorded on bead **qwen-coprocessor-stack-pwa** and in T2).
