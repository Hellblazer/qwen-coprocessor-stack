# RDRs (Research-Design-Review)

Architectural decisions and their rationales for the
**qwen-coprocessor-stack** project. Each RDR captures one decision: the
context that forced it, the options considered, the choice made, and the
consequences accepted.

Lifecycle: `draft` → `proposed` → `accepted` → `final` (or `superseded`).
Acceptance is gated by a substantive critique pass (see
`/nx:rdr-gate`) and recorded in T2 (`qwen-coprocessor-stack_rdr` project
namespace) for cross-session discoverability.

## Index

| ID  | Status              | Type         | Title |
|-----|---------------------|--------------|-------|
| 001 | final (implemented) | architecture | [Qwen-as-coprocessor — stateful Node MCP server with multi-backend routing](RDR-001-qwen-coprocessor-mcp-server.md) |
| 002 | draft               | architecture | [Plugin management — exposing the inner Qwen's tool surface to the operator](RDR-002-plugin-management.md) |
| 003 | draft               | architecture | [Observability — structured logs, per-backend metrics, optional traces](RDR-003-observability.md) |
| 004 | draft               | architecture | [Multi-Qwen fleet management — declarative config, tmux-as-lifecycle, mosh-attached operator UX](RDR-004-multi-qwen-fleet-management.md) |
