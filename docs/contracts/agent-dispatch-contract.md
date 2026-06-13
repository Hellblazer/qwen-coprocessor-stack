<!-- SPDX-License-Identifier: MIT -->
# Agent Dispatch Contract (RDR-007 §4)

**Status:** published · **Source RDR:** RDR-007 (accepted) · **Golden fixtures:** [`docs/contracts/fixtures/`](./fixtures/)

This is the **language-neutral** contract for the unified agent-dispatch spine.
It pins (a) the **shapes** that cross the dispatch boundary and (b) the **pure
decision rules** that every host must compute identically. It is normative for
the two in-repo routers and is the reference an external adopter (e.g. the
nexus `pick_dispatcher_for`, out of scope for RDR-007) **may** adopt — adoption
means conforming to the same golden fixtures, not sharing code.

The two conforming hosts today:

| Host | Language | Location |
|------|----------|----------|
| MCP supervisor | TypeScript | `mcp-bridges/qwen-agent-server/src/{types,dispatch,backends}.ts` |
| Coding-eval spine | Python | `scripts/coding-eval/run_arm.py` |

## RF-1 — pure logic is shared; host effects are not

The contract covers **pure logic and shapes only**. Side effects stay local to
each host and are deliberately **not** part of this contract: the `git diff`
patch extraction (against the instance `base_commit`, source-only), the
process-group wall-clock kill, and the prediction file write. Centralizing them
was the rejected alternative; RF-1 keeps each host owning its own effects. A
golden fixture therefore never encodes an effect — only an `(input → expected)`
of a pure rule or a shape's key set.

## Normative shapes

JSON, language-neutral. Field names are the wire keys (camelCase) and are
identical across hosts so a fixture is byte-identical. TypeScript expresses
these as `interface`s; Python as `TypedDict`s — both are the same JSON object at
runtime.

### `AgentOutcome`
A closed set of strings: `"completed"`, `"timeout"`, `"turn_limit"`, `"error"`.
`timeout` is owned by the host's wall-clock runner; the other three come from
the classify-outcome rule below.

### `AgentTask`
One unit of agentic work handed to a provider.

| key | type | meaning |
|-----|------|---------|
| `prompt` | string | the task/problem statement |
| `worktree` | string | absolute path to the isolated tree the agent edits (also the host's `extractPatch` target) |
| `maxTurns` | int | turn budget; `turns >= maxTurns` ⇒ `turn_limit` |
| `minTokens` | int | per-turn output-token floor (reasoning-clearing floor) |
| `timeout` | int | wall-clock cutoff in **milliseconds** |

> **Unit note.** `timeout` is milliseconds in the contract. A host whose native
> runner takes another unit converts **locally** (the Python host's
> `run_with_timeout` takes seconds, so `build_agent_task` emits
> `seconds * 1000` and the conversion back is host-local — an RF-1 effect, not a
> contract concern).

### `AgentResult`
The result of a one-shot agentic run.

| key | type | meaning |
|-----|------|---------|
| `patch` | string | source-only diff from the host's `extractPatch` (never the agent's self-reported patch) |
| `turns` | int | turns the agent used |
| `outcome` | `AgentOutcome` | see above |
| `cost` | number | USD (metered providers; `0` for free-local) |

Host-internal fields are **not** in the contract: the Python `RunResult` also
carries `instance_id` / `arm` (run identity), `test_edit_contamination`
(host-internal contamination flag), `duration_seconds`, `returncode`, and a
`telemetry` bag. `turns` and `cost` are **lifted out of telemetry** at the
boundary (Arm A reports `telemetry.turns`; Arms B/C report `telemetry.num_turns`
— cost is `total_cost_usd` for the metered Arm C, `cost_usd`/absent for the
free-local qwen arms). The projection normalizes these; see
`run_result_to_agent_result`.

## Normative pure logic & host scope

Not every pure rule exists on both hosts — the dispatch boundary is asymmetric.
The TS host **routes** dispatch calls (it picks a provider) and **receives** a
prompt; the Python eval host **renders** the shared prompt and does **not**
route backends. Forcing a renderer onto the TS host or a router onto the Python
host would be inventing logic that does not exist (and would violate RF-1
scope). So each surface declares its conformance scope:

| Surface | Rule | TS impl | Python impl | Golden fixture | Conformance hosts |
|---------|------|---------|-------------|----------------|-------------------|
| **classify-outcome** | `rc≠0`(or null)→`error`; else `turns≥max`→`turn_limit`; else `completed` | `classifyOutcome` | `classify_outcome` | `classify-outcome.json` | **TS + Python** |
| **shapes** | `AgentTask`/`AgentResult` key sets + `AgentOutcome` values | interfaces | TypedDicts | `agent-shapes.json` | **TS + Python** |
| **prompt-render** | the shared task-prompt template render | — | `build_prompt` | `prompt-render.json` | **Python** (normative-if-adopted) |
| **task-classification** | precedence: `json_schema`→`schemaSynth`; `opts`→`agenticLoop`; modality `embedding`/`rerank`; else `chat` | `classifyTask` | — | `task-classification.json` | **TS** (normative-if-adopted) |

The **classify-outcome** rule is a verbatim port across the two hosts — the one
piece most prone to silent cross-language drift. Its golden fixture is the
**drift tripwire** for RDR-007 Consequence Negative-1: if either host's rule
changes without the other, the shared fixture fails on that host. This is the
mitigation the stacked-review gate exists to enforce.

> **Reconciliation (RDR-007 azf.8 S2).** An earlier framing assumed all three
> pure surfaces were cross-host. They are not: `prompt-render` is Python-only
> and `task-classification` is TS-only. Their fixtures live in the shared dir
> and are **normative-if-adopted** — a second host that ever implements the
> surface must match the fixture — but today each is asserted on its single
> implementing host.

## Golden fixtures

All under [`docs/contracts/fixtures/`](./fixtures/); each carries a
`$schema_note` describing its scope. Both hosts resolve this directory by a
repo-root-relative path and assert the cases:

- TS: `mcp-bridges/qwen-agent-server/tests/contract-conformance.test.ts` (vitest)
- Python: `scripts/coding-eval/tests/test_contract_conformance.py` (pytest)

A `null` value in a fixture input means "signal not supplied" (TS: `undefined` /
omitted; Python: `None`). Adding a case to a cross-host fixture is the way to
extend the contract: both host suites pick it up automatically.
