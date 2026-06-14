<!-- SPDX-License-Identifier: MIT -->
# Proposal: adopt `qwen_dispatch` as a nexus agentic-dispatch operator

> **FILED:** [Hellblazer/nexus#1174](https://github.com/Hellblazer/nexus/issues/1174)
> (RDR-008 §Approach item 3, acceptance criterion (a)). This document is the
> source of that issue body — it proposes the operator-interface signature and
> registration ceremony for nexus to wire `qwen_dispatch` as a typed operator.

## Summary

The qwen-coprocessor-stack supervisor publishes `qwen_dispatch` (RDR-008): an MCP
tool that runs one bounded agentic coding task on a local-Qwen agent and returns
an `AgentResult`. This proposes nexus adopt it as a typed **agentic-dispatch
operator** — the agentic counterpart to nexus's retrieval operators
(`search`/`extract`/`rank`/…) — usable as a plan step (`plan_run`) and matchable
(`plan_match`).

Full contract: `docs/contracts/qwen-dispatch-operator-contract.md` +
golden fixture `docs/contracts/fixtures/qwen-dispatch-shapes.json` in the
qwen-coprocessor-stack repo. Adoption = conforming to the fixture, **not** sharing
code (same posture as RDR-007's agent-dispatch contract).

## Proposed operator signature

A typed operator over the published shapes:

```
operator qwen_dispatch:
  input:
    prompt:      string          # required — task statement
    worktree:    string (abs)    # required — caller-supplied tree the agent edits
    base_commit: string          # required — patch diffed vs this, NEVER HEAD
    max_turns?:   int            # default 50
    min_tokens?:  int            # default 16384
    timeout_ms?:  int            # default 1_800_000 (milliseconds)
    provider_id?: string         # pin a declared provider (overrides agent_kind)
    agent_kind?:  string         # dispatcher family, default "qwen-local"
  output (AgentResult):
    patch:   string              # source-only diff (test paths stripped)
    turns:   int                 # real completed-turn count (qcs-j2r)
    outcome: "completed" | "timeout" | "turn_limit" | "error"
    cost:    number              # 0 for free-local
  error:
    { code: "no_provider" | "missing_agent_kind" | "unregistered_kind" | "shutting_down",
      message: string }
```

## What nexus must know (normative)

1. **Strictly one-shot — no resume path.** A session reaching `idle` is terminal.
   nexus MUST NOT design a resume-the-executor continuation against this operator.
   Continuations (suspend/resume, elicitation, sampling, choice injection) are
   **engine** concerns: implement them in the nexus engine and call `qwen_dispatch`
   for the **leaf** agentic work. The executor never pauses or yields mid-run.
2. **The engine owns the worktree + base_commit.** Default strategy is
   caller-supplied worktree: nexus passes a ready worktree path + its
   `base_commit`; lifecycle (create/cleanup) is nexus's. The executor only runs +
   extracts.
3. **Registration ceremony.** The executor host declares an `agent-cli` provider
   (`agent_providers` config) and registers a `DispatcherKind → Dispatch`. On the
   nexus side, the analogous step is registering `qwen_dispatch` as a typed
   operator keyed to the shapes above.
4. **`turns`.** Carries the real completed-turn count on success
   (qwen-coprocessor-stack-j2r — `PollResult.turns_completed` is always-present).

## Out of scope (this proposal)

The nexus workflow engine, plan library, `plan_save` capture, and the
continuation machinery — those are nexus's to design. This proposal states only
what the **executor** provides and requires.

## Acceptance

- **Status: FILED, pending nexus sign-off.** The qwen-coprocessor-stack side is
  complete and pinned (`qwen-dispatch-shapes.json` + the conformance test landed
  in RDR-008 P3). The interface signature here is **proposed**; it becomes
  *agreed* once nexus responds on [#1174](https://github.com/Hellblazer/nexus/issues/1174)
  (acks the signature, or proposes amendments folded back here).
