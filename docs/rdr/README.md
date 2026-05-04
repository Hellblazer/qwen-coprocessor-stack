# RDRs (Research-Design-Review)

Architectural decisions and their rationales for the
**qwen-coprocessor-stack** project. Each RDR captures one decision: the
context that forced it, the options considered, the choice made, and the
consequences accepted.

Lifecycle: `draft` → `proposed` → `accepted` → (optional) `superseded`.
Acceptance is gated by a substantive critique pass (see
`/nx:rdr-gate`) and recorded in T2 (`qwen-coprocessor-stack_rdr` project
namespace) for cross-session discoverability.

## Index

| ID  | Status   | Type         | Title |
|-----|----------|--------------|-------|
| 001 | accepted | architecture | [Qwen-as-coprocessor — stateful Node MCP server with multi-backend routing](RDR-001-qwen-coprocessor-mcp-server.md) |

## Future / placeholder

| ID  | Anticipated scope |
|-----|-------------------|
| 002 | Per-plugin catalogue: which plugins / agents / skills / commands / hooks live under `plugins/`, install order, per-plugin scope decisions, integration test plan. |
| 003 | Observability hooks: structured logging via `pino`, optional Langfuse client for trace events, sampling policy. |
