# Architecture

How the qwen-coprocessor-stack is built and why. The design records under
[`docs/rdr/`](rdr/) carry the detailed rationale; the source under
[`mcp-bridges/qwen-agent-server/src/`](../mcp-bridges/qwen-agent-server/src/) is
the ground truth. This document is the overview that ties them together.

For task recipes see the [User Guide](USER_GUIDE.md); for building, testing, and
operating it see the [Development & Operations guide](DEVELOPMENT.md).

---

## Overview

```mermaid
flowchart LR
  CC["Claude Code<br/>(unmodified, subscription auth)"]
  SUP["qwen-agent-server<br/>(Node + TypeScript MCP supervisor)"]
  B1["llama.cpp · Metal<br/>Qwen 3.6 27B (Mac)"]
  B2["llama.cpp · Vulkan<br/>Qwen 3.6 35B-A3B (Strix Halo)"]
  B3["remote OpenAI-compat<br/>(OpenRouter / Together / …)"]
  EMB["bge-m3 (embeddings)"]
  RR["bge-reranker (rerank)"]

  CC -->|"MCP stdio · qwen_* tools"| SUP
  SUP -->|"pooled · KV-cache affine"| B1
  SUP --> B2
  SUP --> B3
  SUP --> EMB
  SUP --> RR
```

Claude Code runs unmodified, on a normal subscription. It gains a small family
of `qwen_*` MCP tools. When Claude calls one, the **supervisor** routes the work
to a locally-hosted (or remote) Qwen backend and manages everything stateful
about that delegation: which backend, how long the session lives, how the
prefix cache stays warm, what the model is allowed to do, and when to abort a
runaway.

The use case is delegating cheap or bulk work. Claude stays the orchestrator;
Qwen takes the high-volume or cost-sensitive turns (bulk extraction,
schema-bounded synthesis, OCR, a long coding run) on local hardware.

---

## What the supervisor adds

Four properties distinguish it from a thin proxy. Each is covered by a design
record.

1. **Stateful, KV-cache-affine session pool.** A `qwen_spawn` creates a
   long-lived session pinned to exactly one backend for its whole life, so
   `llama.cpp`'s prefix cache stays warm across turns (~98% prefix-cache hit on
   turn 2 within a session). Sessions are reaped by LRU and idle timeout.
   ([RDR-001](rdr/RDR-001-qwen-coprocessor-mcp-server.md))

2. **Config-driven multi-modal, multi-backend routing.** A mixed pool (a chat
   model + an embedder + a reranker + a remote heavy box over Tailscale) is
   declared as pure data in one config file. `chooseBackend` filters by
   modality, tier, capacity, and health, then load-balances. Add a backend by
   editing JSON; the supervisor hot-applies on the next spawn.

3. **A published cross-host dispatch contract.** Dispatch returns a typed,
   four-kind `Artifact[]` whose shape is asserted *byte-identically* by both a
   TypeScript and a Python conformance suite, so a downstream orchestrator
   (e.g. [nexus](https://github.com/Hellblazer/nexus)) can build against it.
   ([RDR-007](rdr/RDR-007-unified-agent-dispatch-contract.md)
   → [RDR-011](rdr/RDR-011-entity-tier-producer-contract.md))

4. **An evaluation harness.** A three-arm SWE-bench harness measures the
   supervisor path against the raw CLI and against Claude, with a shared
   fairness spine and the methodology invariants built in.
   ([RDR-006](rdr/RDR-006-coding-agent-eval.md))

---

## Component map

```mermaid
flowchart TB
  subgraph host["Mac running Claude Code"]
    CC["Claude Code"]
    subgraph sup["qwen-agent-server (one Node process)"]
      TOOLS["MCP tool surface<br/>(server.ts)"]
      POOL["session pool<br/>(pool.ts · session.ts)"]
      ROUTER["backend router<br/>(backends.ts)"]
      DISP["dispatch executor<br/>(dispatch.ts · dispatch-tool.ts)"]
      MODAL["direct modality handlers<br/>(vision · embed · rerank · tokenize · chat)"]
      PERM["permission gate<br/>(permissions.ts)"]
      THREADS["oneshot threading<br/>(threads.ts)"]
    end
  end
  subgraph backends["inference backends (any OpenAI-compatible /v1)"]
    LB["llama.cpp / MLX / remote"]
  end

  CC -->|MCP stdio| TOOLS
  TOOLS --> POOL
  TOOLS --> MODAL
  TOOLS --> DISP
  POOL --> ROUTER
  MODAL --> ROUTER
  DISP --> POOL
  POOL --> PERM
  TOOLS --> THREADS
  ROUTER -->|HTTP| LB
```

The node labels are the source files; read them for the detail. The rest of this
document covers the three parts worth understanding before you do: the session
pool, the router, and the dispatch contract.

---

## The session lifecycle

A pooled session (`qwen_spawn` → `qwen_poll` → `qwen_send` → `qwen_stop`) is a
small state machine. The supervisor never blocks on inference: `qwen_spawn`
returns a `task_id` immediately and the model runs asynchronously; the caller
polls.

```mermaid
stateDiagram-v2
  [*] --> running: qwen_spawn
  running --> idle: turn finishes,<br/>awaiting input
  running --> complete: agent signals done
  running --> error: backend fault /<br/>budget exceeded
  idle --> running: qwen_send (next turn)
  idle --> complete: agent ends
  complete --> [*]: qwen_stop (idempotent)
  error --> [*]: qwen_stop
```

The four states are exactly `running | idle | complete | error`
(`SessionState`, `types.ts`). `idle` is terminal *for a one-shot* but resumable
in a pooled multi-turn session via `qwen_send`. Clarifying questions are not a
state: the supervisor excludes `ask_user_question` from the inner Qwen's tool
surface, so a question surfaces as plain assistant text and is answered with
`qwen_send` ([RDR-001 §Q1](rdr/RDR-001-qwen-coprocessor-mcp-server.md)).

**Multi-turn input** rides a single `streamInput` async generator per session:
`qwen_send` pushes a message into a queue and wakes the generator. Messages
accumulate; the wake is just a signal, so back-to-back sends never collapse a
turn.

**KV-cache affinity.** Each `task_id` is bound to its backend at spawn and stays
there for the session's life. That is what keeps `llama.cpp`'s prefix cache warm
turn-over-turn — re-routing mid-session would cold-start the cache on a
different server every turn.

### The session budget

The inner Qwen has no automatic mid-flight compaction, so an open-ended task can
accumulate `tool_result` payload past the backend's context window and crash the
HTTP layer with `ECONNRESET`. The budget aborts cleanly first.

```mermaid
flowchart LR
  A["accumulate tool_result<br/>(chars / 4 estimate)"] --> P50{"≥ 50%?"}
  P50 -->|yes, once| W["context_pressure: warn"]
  P50 --> P75{"≥ 75%?"}
  P75 -->|yes, once| H["context_pressure: high"]
  P75 --> P90{"≥ 90%?"}
  P90 -->|yes, once| C["context_pressure: critical"]
  P90 --> P100{"≥ 100%?"}
  P100 -->|yes| ERR["state=error<br/>code=context_exceeded"]
```

Two per-session caps: `max_context_tokens` (default `111000`, or
`floor(0.85 × backend.ctx_size)` when the chosen backend declares one) and
`max_tool_calls` (default `0` = unlimited). Every `qwen_poll` carries a live
`budget` counter so a poller can wind down between thresholds; the pressure
events fire once each so an event-only caller still gets early warning.
([RDR-002 §Session budget](rdr/RDR-002-extension-management.md))

---

## The backend router

`chooseBackend` (`backends.ts`) is a deterministic filter pipeline. Each stage
narrows the candidate pool; the last stage picks one.

```mermaid
flowchart TB
  POOL["all configured backends"] --> PIN{"opts.backend pin?"}
  PIN -->|yes| RET["return that backend<br/>(bypasses all filters)"]
  PIN -->|no| MOD["filter by MODALITY<br/>(text / multimodal / embedding / rerank)"]
  MOD --> TIER["filter by TIER<br/>(local / remote; prompt-driven)"]
  TIER --> CAP["filter by CAPACITY<br/>(fast vs heavy)"]
  CAP --> HEALTH["drop UNHEALTHY<br/>(optimistic, stale-while-revalidate)"]
  HEALTH --> WRR["WEIGHTED ROUND-ROBIN<br/>across survivors"]
  WRR --> PICKED["chosen backend"]
  HEALTH -->|empty| FALL["fall back to local pool"]
```

- **Modality** is the hard gate: chat (`qwen_spawn`/`qwen_oneshot`) only
  considers `text`/`multimodal`; `qwen_oneshot_vision` requires `multimodal`;
  `qwen_embed`/`qwen_rerank` require their matching modality. Declaring modality
  correctly is what makes a mixed pool safely auto-routable.
- **Capacity** is a prompt-size heuristic (`classifyCapacity`): `heavy` if the
  estimated token count clears `ROUTER_HEAVY_THRESHOLD_TOKENS` (default 2000) or
  the prompt matches a heavy keyword (`prove`, `derive`, `architect`, `design`);
  else `fast`.
- **Health** is optimistic: an unprobed backend is treated as healthy and probed
  in the background (stale-while-revalidate), so a cold spawn never blocks on a
  health check.
- **Weighted round-robin** is the load-balancer: `weight` biases the share;
  `weight ≤ 0` is clamped to 1 so a misconfigured zero degrades to equal
  weighting rather than starving the pool.

Config is read from `~/.qwen-coprocessor-stack/config.json`, mtime-cached, and
hot-applied on the next spawn. In-flight sessions stay pinned to their original
backend — config edits affect new spawns only.

---

## Two dispatch paths

The supervisor exposes work in two distinct shapes, and the difference matters.

```mermaid
flowchart TB
  subgraph pooled["Stateful pool (KV-affine, multi-turn)"]
    SPAWN["qwen_spawn / poll / send / stop"]
    ONESHOT["qwen_oneshot (spawn→wait→stop, optional JSON-schema retry)"]
  end
  subgraph direct["Stateless direct (per-request, bypass SDK)"]
    VIS["qwen_oneshot_vision"]
    EMB2["qwen_embed"]
    RR2["qwen_rerank"]
    TOK["qwen_tokenize"]
    CHAT["qwen_chat"]
  end
  subgraph exec["Executor dispatch (RDR-008)"]
    DISP2["qwen_dispatch → Artifact[]"]
  end
```

- **Stateful pool** — `qwen_spawn`/`qwen_poll`/`qwen_send`/`qwen_stop` and the
  convenience wrapper `qwen_oneshot`. These go through the SDK and the session
  pool; they get KV-cache affinity and the budget.
- **Stateless direct** — `qwen_oneshot_vision`, `qwen_embed`, `qwen_rerank`,
  `qwen_tokenize`, `qwen_chat`. These bypass the SDK entirely and POST
  OpenAI-compat content directly to a backend. No pool, no session, no
  KV-affinity — each call is independent. (The SDK is text-only, so vision *must*
  take the direct path.)
- **Executor dispatch** — `qwen_dispatch` runs a one-shot agentic task against a
  git worktree and returns a typed `Artifact[]`. This is the contract surface a
  downstream orchestrator calls.

---

## The dispatch contract stack

A downstream system (the canonical one is
[nexus](https://github.com/Hellblazer/nexus)) needs to dispatch an agentic task
to either Claude or Qwen and get back a uniform, typed result it can fold into
its own ledger. Five design records build that contract in layers.

```mermaid
flowchart TB
  R7["RDR-007 — Unified dispatch contract<br/>one AgentProvider registry + one dispatch() interface"]
  R8["RDR-008 — Agentic dispatch executor<br/>dispatch() as a nexus-callable MCP operator (qwen_dispatch)"]
  R9["RDR-009 — Harvest envelope<br/>dispatch returns Artifact[] (push+pull), not a bare patch"]
  R10["RDR-010 — Value harvest<br/>a leaf's structured finalMessage → {kind:value}"]
  R11["RDR-011 — Producer contract<br/>what an orchestrator emits for entity/tier"]
  R7 --> R8 --> R9 --> R10 --> R11
```

The payload is a **four-kind `Artifact` union** — and exactly four, by design;
adding a fifth requires a real consumer:

```mermaid
flowchart LR
  ART["Artifact"] --> P["patch<br/>git diff (PULL: harvested off the worktree)"]
  ART --> V["value<br/>leaf's structured finalMessage (PULL)"]
  ART --> E["entity<br/>bead / link / rdr created|updated (PUSH)"]
  ART --> T["tier<br/>T1/T2/T3 store write (PUSH)"]
```

The split:

- **The executor is one-shot and emits only `patch`/`value`.** It harvests the
  git diff off the worktree (PULL) and parses the leaf's final message (PULL). It
  never produces `entity`/`tier`.
- **`entity`/`tier` are orchestrator (PUSH) scope** — emitted by the deterministic
  spine that *knows* it created a bead or wrote a tier, at the time it does so.
  That producer lives in the downstream orchestrator (nexus), not here. This repo
  publishes the *contract* for it
  ([`docs/contracts/harvest-producer-contract.md`](contracts/harvest-producer-contract.md)),
  not the producer.

### Cross-host conformance tripwire

The four-kind union and the artifact shapes are pinned by a single golden
fixture, [`docs/contracts/fixtures/agent-shapes.json`](contracts/fixtures/agent-shapes.json),
asserted by **both** a TypeScript conformance suite and a Python one. If the TS
host (the supervisor) and the Python host (the eval harness / a downstream
re-implementation) ever drift on the wire shape, one of the two suites goes red.
That is the mechanism that lets two languages share one contract without a shared
schema compiler. See the [Development guide](DEVELOPMENT.md#the-contract--conformance-discipline)
for how to evolve it safely.

---

## The evaluation harness

Lives in [`scripts/coding-eval/`](../scripts/coding-eval/). It measures two
things: whether routing a coding agent through the supervisor costs anything in
resolve-rate, and how local Qwen compares to Claude. Three arms, one shared
fairness spine.

```mermaid
flowchart TB
  subgraph spine["Shared fairness spine (run_arm.py)"]
    PR["verbatim prompt"]
    PE["arm-uniform patch extraction (git diff vs base_commit)"]
    TO["wall-clock timeout + process-group kill"]
    OC["outcome classification"]
    PW["prediction writer"]
  end
  A["Arm A — Qwen via the MCP supervisor<br/>(the headline: the real hand-off path)"]
  B["Arm B — raw qwen-code CLI, same model<br/>(control: isolates the supervisor wrapper)"]
  C["Arm C — claude -p (sonnet)<br/>(baseline)"]
  spine --> A
  spine --> B
  spine --> C
```

Only the *invocation flags* differ per arm; prompt, patch extraction, timeout,
and scoring are byte-identical across all three, so A−B isolates the supervisor
overhead and A/B−C measures the model gap. The harness encodes several
methodology rules — never compare numbers across harnesses, gold-validate any
subset before trusting it, `temperature=0` causes deterministic agentic loops —
documented in the [Development guide](DEVELOPMENT.md#evaluation-methodology)
and [`docs/qwen-coding-agent-eval.md`](qwen-coding-agent-eval.md).

---

## Topology in production

The reference deployment is two machines:

```mermaid
flowchart LR
  subgraph mac["Mac · M4 Max · 128 GB · ~546 GB/s"]
    CCm["Claude Code + supervisor"]
    MLX["MLX backend (-w1)"]
  end
  subgraph box["qwentescence · Strix Halo · AMD 8060S iGPU · 128 GB · ~256 GB/s"]
    CODER["coder-box (49 GB) · llama.cpp Vulkan b9596+"]
    VISION["vision-box (21 GB)"]
  end
  CCm -->|MCP stdio| MLX
  CCm -->|HTTP over Tailscale| CODER
  CCm --> VISION
```

Both machines can host 30–120B small-active-MoE models; memory bandwidth (not
capacity) is the decode bottleneck. The box has several operational constraints:
GPU memory is load-order-sensitive, servers cannot detach from SSH, the
`qwen3_next` arch needs llama.cpp ≥ b9596. All are captured in the
[operations runbook](DEVELOPMENT.md#operations-runbook). The
[`scripts/`](../scripts/) directory holds the launchers, the keepalive
LaunchAgent, and the setup paths for both hosts.

---

## Where to go deeper

- **Decision records** — [`docs/rdr/`](rdr/). RDR-001 is the primary design doc;
  007–011 are the dispatch-contract stack.
- **Published contracts** — [`docs/contracts/`](contracts/). The executor
  contract, the producer contract, and the golden fixtures.
- **Downstream integration** — [`docs/integrations/`](integrations/). The nexus
  dispatch design and bench evidence.
- **The code** — [`mcp-bridges/qwen-agent-server/src/`](../mcp-bridges/qwen-agent-server/src/).
  Start at `server.ts` (the tool surface) and `backends.ts` (the router).
