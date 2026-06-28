# RDRs (Research-Design-Review)

Architectural decisions and their rationales for the
**qwen-coprocessor-stack** project. Each RDR captures one decision: the
context that forced it, the options considered, the choice made, and the
consequences accepted.

Lifecycle: `draft` → `proposed` → `accepted` → `closed` (terminal, with a
`close_reason` of `implemented` / `superseded` / `abandoned`). `deferred` is
an off-path parked state — work paused, not abandoned, with documented revival
conditions. Acceptance is gated by a substantive critique pass (see
`/nx:rdr-gate`) and recorded in T2 (`qwen-coprocessor-stack_rdr` project
namespace) for cross-session discoverability.

## Index

| ID  | Status                | Type         | Title |
|-----|-----------------------|--------------|-------|
| 001 | closed (implemented)  | architecture | [Qwen-as-coprocessor — stateful Node MCP server with multi-backend routing](RDR-001-qwen-coprocessor-mcp-server.md) |
| 002 | deferred              | architecture | [Extension management — exposing the inner Qwen's tool surface to the operator](RDR-002-extension-management.md) |
| 004 | deferred              | architecture | [Multi-Qwen fleet management — declarative config, tmux-as-lifecycle, mosh-attached operator UX](RDR-004-multi-qwen-fleet-management.md) |
| 005 | deferred              | architecture | [Supervisor process lifecycle — layered cleanup model](RDR-005-supervisor-process-lifecycle.md) |
| 006 | closed (implemented)  | research     | [Coding-agent evaluation — Qwen3.6-35B-A3B vs Claude on SWE-bench Lite, three arms](RDR-006-coding-agent-eval.md) |
| 007 | closed (implemented)  | design       | [Unified agent dispatch contract — one AgentProvider registry + one dispatch interface across Claude and Qwen](RDR-007-unified-agent-dispatch-contract.md) |
| 008 | closed (implemented)  | design       | [Agentic dispatch executor — a pluggable dispatcher framework exposing dispatch() as a nexus-callable MCP operator](RDR-008-agentic-dispatch-executor.md) |
| 009 | closed (implemented)  | architecture | [Generalized harvest envelope — dispatch returns a typed Artifact[] (push+pull) instead of a patch; nexus owns the ledger](RDR-009-harvest-envelope.md) |
| 010 | closed (implemented)  | design       | [Executor value-harvest — a dispatched leaf returns its structured finalMessage as a {kind:value} artifact](RDR-010-executor-value-harvest.md) |
| 011 | closed (implemented)  | design       | [Entity/tier producer contract — what an orchestrator must emit for the entity/tier Artifact kinds, and how they compose with executor patch/value artifacts](RDR-011-entity-tier-producer-contract.md) |
| 012 | accepted              | design       | [Agentic-path remote credentials — forward per-backend auth so qwen_spawn/qwen_oneshot can drive authenticated remote OpenAI-compatible providers (OpenRouter, Together, Fireworks)](RDR-012-agentic-path-remote-credentials.md) |
