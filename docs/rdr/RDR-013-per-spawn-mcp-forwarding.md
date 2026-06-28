---
title: "Per-spawn MCP server forwarding — let qwen_spawn/qwen_oneshot provision the inner qwen-code agent with per-task MCP tools"
id: RDR-013
type: Design
status: accepted
priority: medium
author: hal
reviewed-by: self
created: 2026-06-28
accepted_date: 2026-06-28
related_issues: []
---

# RDR-013: Per-spawn MCP server forwarding

> Revise during planning; lock at implementation.
> If wrong, abandon code and iterate the RDR.

## Status

**Draft (2026-06-28).** Phase 1 of the harness adopt-vs-rewrite decision
(T2 `qwen-coprocessor-stack/decision-harness-adopt-vs-rewrite-2026-06-27`):
**extend in place**. This RDR closes the one real provisioning gap — the
coprocessors cannot be given MCP tools per task.

## Problem Statement

The inner qwen-code agent (driven via `@qwen-code/sdk` `query()` in
`src/session.ts`) is MCP-capable, but the supervisor never tells it about any
MCP servers. So `qwen_spawn`/`qwen_oneshot` agents run with the built-in
qwen-code toolset only (file ops, shell, glob/grep) — no project-specific or
external MCP tools (e.g. a code-intelligence LSP server, a docs server, an
internal API). Today the only way to give a coprocessor extra tools is a
host-installed qwen-code **extension** (RDR-002), which is global and static,
not per-task.

This blocks the converged "provision the agent with the tools the task needs"
pattern: an orchestrator should be able to say *"spawn this coding sub-task
with these MCP servers attached."*

## Context

- **The delivery mechanism is the control protocol, NOT flags/env (VERIFIED).**
  `@qwen-code/sdk` forwards MCP servers to the CLI in-band:
  `Query.initialize()` calls
  `sendControlRequest("initialize", { sdkMcpServers, mcpServers, agents })`
  over the SDK↔CLI stdio channel (confirmed in
  `node_modules/@qwen-code/sdk/dist/index.mjs`). `QueryOptions.mcpServers:
  Record<string, McpServerConfig>` is the input. Because the supervisor calls
  `query()` directly, forwarding is simply adding `mcpServers` to the
  `queryOptions` object in `session.ts`.
- **The wrapper bridge (RDR-002) is irrelevant to this.** `scripts/qwen-extensions-wrapper.sh`
  only `exec`s the real binary with `--extensions` prepended and `"$@"`; MCP is
  negotiated over the control protocol *after* exec, so no `QWEN_AGENT_MCP_SERVERS`
  env var and no `--mcp-server` flags are needed. (An earlier research draft
  proposed that env-channel route; it was based on the false premise that the
  SDK passes mcpServers as CLI args. Superseded.)
- **SDK `McpServerConfig` has four shapes:** stdio (`command`/`args`/`env`/`cwd`),
  SSE (`url`), HTTP (`httpUrl`/`headers`), and in-process SDK (`type:"sdk"`,
  `instance`). Only the first three are JSON-serializable and can cross the MCP
  tool boundary; the SDK-instance form is a live object and is out of scope.
- **RDR-012** (closed): per-backend credentials reach both paths; this RDR is
  the provisioning sibling. **RDR-007/008** (closed): the `dispatch.ts`
  `agent-cli`/`DispatcherKind` seam is the future home for a *second* harness;
  unaffected here.

## Decision

### In scope

1. **Forward `opts.mcpServers` into `queryOptions.mcpServers`.** Add an optional
   `mcpServers` field to `SpawnOpts` (`src/types.ts`) and conditionally set it on
   the `queryOptions` object in `session.ts` (conditional spread, required under
   `exactOptionalPropertyTypes`). When unset, behavior is byte-for-byte
   unchanged. The MCP servers are per-session and torn down with the session
   (the SDK owns their lifecycle; no supervisor-side pooling). **The
   `SpawnOpts.mcpServers` docstring MUST state the write_authority
   non-relationship (gate finding S3):** a stdio MCP server's `command` is
   spawned at SDK session *initialization*, before any tool call, so it is NOT
   gated by `permissionMode`/`canUseTool` — `write_authority: false` does
   **not** make a session with stdio `mcpServers` read-only. Callers must treat
   `mcpServers` as trusted input.
2. **Accept only the JSON-serializable external configs at the tool boundary;
   REJECT the in-process form (gate finding S2).** The `qwen_spawn` /
   `qwen_oneshot` MCP tool input schema (zod, `src/server.ts`) gains `mcpServers`
   as a record of the stdio / SSE / HTTP shapes only. An entry with
   `type: "sdk"` (the live-instance form) must cause `safeParse` to **fail** —
   a validation error returned at the tool boundary — **not** be silently
   stripped. (Stripping would hand the inner SDK a `type:"sdk"` config with no
   `instance` → crash/no-op; reject gives the caller a clear diagnostic. This is
   the RDR-012 S1 precedent: never silently drop a misconfigured field.)
   Implementation note (verified against the SDK `.d.ts`): `CLIMcpServerConfig`
   (stdio/sse/http) has **no `type` discriminator** — the three shapes are one
   struct keyed by which of `command`/`url`/`httpUrl` is populated; only
   `SDKMcpServerConfig` carries `type: "sdk"`. So the schema rule is "reject any
   entry whose `type === "sdk"`", not a three-way union. Without this schema entry
   at all, the whole field is silently stripped before the handler — the trap this
   item exists to prevent.
3. **Also forward `opts.agents` (subagent definitions) via the same
   `initialize` message.** The control-protocol `initialize` request carries
   `agents` as a distinct field alongside `mcpServers`; threading
   `queryOptions.agents` is the same one-line shape and completes the
   provisioning story (custom named subagents per spawn). Same boundary-schema
   treatment. **Invariant + guard (gate finding S1):** `agents[]` is only
   reachable when the built-in `agent`/`task` tool is available, i.e. when
   `allow_subagents === true` — otherwise `DEFAULT_EXCLUDED_TOOLS` (built at
   `session.ts:204-206`) excludes `agent` and the forwarded agents are a silent
   dead config (visible to the SDK, undispatchable). The constructor MUST emit a
   structured WARN (`event_type: "agents_without_allow_subagents"`, `backend_id`,
   count) when `opts.agents` is non-empty and `allow_subagents !== true`. The
   `SpawnOpts.agents` docstring states the dependency.
4. **Tests** (reuse the `capturedOptions` SDK mock in `tests/session.test.ts`):
   (a) `opts.mcpServers` present → appears verbatim in captured
   `queryOptions.mcpServers`; (b) absent → `queryOptions.mcpServers` undefined
   (unchanged path); (c) `opts.agents` present **with** `allow_subagents:true` →
   in `queryOptions.agents` and `agent` not in excludeTools; (c2) `opts.agents`
   present **without** `allow_subagents` → constructor emits the
   `agents_without_allow_subagents` WARN (asserted via a log spy);
   (d) the tool zod schema: a stdio config (`{command,args}`) and an http config
   (`{httpUrl}`) `safeParse` **succeed**, and a `{type:"sdk",...}` entry
   `safeParse` **fails** (reject, not strip).

### Out of scope

- **In-process (`type:"sdk"`) MCP servers** — not JSON-expressible across the MCP
  boundary; if ever needed they'd be a supervisor-internal registration, a
  separate concern.
- **Supervisor-side MCP health probing / pooling.** MCP servers are the SDK's to
  manage per session; we do not probe or pool them (unlike inference backends).
- **agent-lsp bundling / a default MCP set** — that is Phase 2 (a config/extension
  concern, separate RDR/bead), built ON this forwarding.
- **The direct-HTTP tools** (`qwen_chat` etc.) — they are not agentic loops and
  have no MCP client; unaffected.

### Bright line

No wrapper-script change, no new env channel, no SDK fork, no supervisor-managed
MCP lifecycle. Forwarding is a thin passthrough of already-supported SDK fields.

### Approach

Implementation phases, each closed by a bead (`ItemN=<closing-bead>`; filed at planning).

1. **`mcpServers` + `agents` passthrough + tool-boundary schema + guard + tests.**
   Add the `SpawnOpts` fields (with the write_authority + allow_subagents
   docstrings per S3/S1); thread both into `queryOptions` in `session.ts` via
   conditional spread; add both to the `qwen_spawn`/`qwen_oneshot` zod schemas
   (external shapes only, **reject `type:"sdk"`** per S2); emit the
   `agents_without_allow_subagents` WARN (S1); tests (a)–(d) incl. (c2).
   `npm run build` clean + `npm test` green. Item1=<bead>.
2. **Docs.** Document per-spawn MCP/agents provisioning in CLAUDE.md (the
   coprocessor tool surface) and an example in the config/docs. Item2=<bead>.

## Research Findings

- **RF-1 — Delivery mechanism. VERIFIED (2026-06-28).** SDK forwards MCP/agents
  via `sendControlRequest("initialize", {sdkMcpServers, mcpServers, agents})` over
  stdio (dist/index.mjs). `queryOptions.mcpServers`/`agents` are the inputs;
  passing them in `session.ts` is sufficient. The wrapper bridge is not involved.
- **RF-2 — Wrapper neutrality. VERIFIED.** `qwen-extensions-wrapper.sh` execs the
  real bin with `"$@"`; MCP is negotiated post-exec over the control protocol, so
  no env/flag plumbing is required.
- **RF-3 — Serializability constraint. VERIFIED.** `McpServerConfig` includes a
  live-object `type:"sdk"` variant that cannot cross MCP; the tool schema must be
  scoped to stdio/SSE/HTTP.
- **RF-4 — Supersession.** The harness research (T2 decision memo) proposed a
  `QWEN_AGENT_MCP_SERVERS` env + `--mcp-server` wrapper route at ~2–3 days; the
  verified mechanism makes that unnecessary and reduces the change to a thin
  passthrough. Recorded so the env-channel design is not revived.

## Consequences

### Positive
- Coprocessors can be provisioned with the exact tools a task needs, per spawn —
  the converged agent-provisioning model, with no new infrastructure.
- Unlocks Phase 2 (bundle agent-lsp etc.) and any future per-task tool set.
- Tiny, low-risk diff (passthrough of existing SDK fields); local-only behavior
  unchanged when the fields are unset.

### Negative
- **Security surface:** a stdio MCP server config carries `command`/`args` that
  the inner agent's host will execute. This is consistent with the existing trust
  model (the MCP caller is the operator, and `qwen_spawn` already runs with
  shell/`write_authority`), but it widens what a caller can cause to run. Document
  it; do not add a sandbox in this RDR (would be a separate hardening decision).
- MCP server failures surface as the SDK/inner-agent sees them (the supervisor
  does not health-probe them), so a bad server config degrades that spawn only.

### Neutral
- `agents` forwarding is included as a sibling of `mcpServers`; both are distinct
  fields of the **same `initialize` control-protocol message**, so scoping them
  together is cheaper than separately. (Title says "MCP forwarding"; agent
  forwarding rides along by implementation co-location — see Decision Item 3.)
