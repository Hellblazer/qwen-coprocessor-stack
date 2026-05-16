# Changelog

All notable changes to the qwen-coprocessor-stack are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This repo's `package.json` is marked `private: true`; tags are git-only
and not published to npm. The two artifacts of interest to operators are
the **supervisor binary** (built via `npm run build` in
`mcp-bridges/qwen-agent-server`) and the **Claude Code plugin** at
`.claude-plugin/plugin.json`.

## [Unreleased]

## [0.9.0] - 2026-05-16

### Fixed

- **Supervisor pino loggers redirected to stderr** ([#1](https://github.com/Hellblazer/qwen-coprocessor-stack/pull/1)).
  Default pino destination is stdout; the supervisor is an MCP stdio
  server, so log lines were interleaving with the JSON-RPC protocol
  channel. Claude Code's MCP plugin tolerated the noise; the reference
  Python MCP SDK rejected it with strict `JSONRPCMessage` pydantic
  validation. Discovered when running nexus's spike-D tier-B bench
  through a Python `mcp.ClientSession`. New shared `createLogger(name)`
  factory in `mcp-bridges/qwen-agent-server/src/log.ts` binds every
  logger to `pino.destination(2)`. Subprocess-level regression test
  asserts stdout is empty + stderr contains pino lines.

### Added

- **`docs/integrations/`** — durable record of downstream consumers.
  - `qwen-dispatch-nexus.md`: design sketch + shipped-state record for
    the nexus integration across operator dispatch, aspect extractor,
    and tier-B agentic tools.
  - `qwen-offload-audit-2026-05-14.md`: ranked candidate audit of
    nexus `claude_dispatch` / `claude -p` call sites.
  - `qwen-offload-2026-05-session-summary.md`: comprehensive
    session-end record (17 PRs, bench results, end-state per call
    site, what we know about Qwen3.6-35B-A3B as a coprocessor).
- **README "Downstream integrations" section** documenting the three
  nexus integration tiers, the `nx` Qwen Code extension prerequisite
  for tier-B routing, and the MCP-stdio protocol note about #1.

### Notes for integrators

Any third-party MCP-stdio client connecting to a pre-0.9.0 supervisor
binary will hit the `JSONRPCMessage` validation error described under
[Fixed]. Rebuild from `main` (or use 0.9.0+) before wiring in.

## [0.8.1] - 2026-05-09

### Fixed

- `qwen_oneshot` strips markdown code fences from JSON-conforming
  responses; the model occasionally wraps schema-valid JSON in
  ` ```json ... ``` ` despite the system-prompt directive.
- Bench harness: extract Claude answer from `structured_output`
  envelope key (prior versions walked `iterations[].message.content[]`,
  which is metadata only).

## [0.8.0] - 2026-05-09

### Added

- **`qwen_oneshot` MCP tool** — stateless single-turn dispatch:
  spawn → wait until idle → optional JSON parse + retry → stop.
  Drop-in shape for `claude -p --json-schema` operator dispatch.
- `SpawnOpts.thinking_mode` (default false; Qwen3.6 ships with
  thinking ON, causes ~6× output bloat on dispatch workloads).
- `SpawnOpts.json_schema` — passed through to the inner Qwen CLI for
  schema-constrained generation.
- `scripts/bench/` — A/B harness comparing `qwen_oneshot` against
  `claude -p --json-schema` across operator-shaped prompts.

## [0.7.0] - 2026-05-08

### Added

- Backend-derived `session_budget` defaults: `max_context_tokens`
  default is now `floor(0.85 × backend.ctx_size)` when the backend
  declares one.
- `qwen_sessions` MCP tool — live overview of pooled sessions
  (task_id, backend, state, last-poll, turns, budget counters).

## [0.6.0] - 2026-05-07

### Added

- Live `budget` field on every `qwen_poll` response carrying
  `est_tokens / max_tokens / tool_calls / max_tool_calls`. Event-only
  pressure-threshold callers were missing early warning when a single
  oversized tool_result tripped multiple thresholds on one iteration.

## [0.5.0] - 2026-05-06

### Added

- `/qwen-stack:budget` slash command — operator-facing surface for
  the `session_budget` caps stored in
  `~/.qwen-coprocessor-stack/config.json`.

## [0.4.0] - 2026-05-06

### Added

- **Session budget guardrail** — caps on accumulated tool_result
  context and tool_call count abort a runaway session cleanly before
  the HTTP layer crashes with `ECONNRESET`. Two caps:
  `max_context_tokens` (chars/4 estimate, default 111k) and
  `max_tool_calls` (default 0 = unlimited).
- `context_pressure` event fires once each at 50 / 75 / 90 % of
  `max_context_tokens` for long-running pollers that want to wind
  down gracefully.

## [0.3.1] - 2026-05-05

### Fixed

- Drop dead `currentTarget` reference; strip the `Type` suffix from
  `info.source` event payloads.

## [0.3.0] - 2026-05-05

### Added

- `/qwen-stack:extensions` and `/qwen-stack:defaults` skills — list
  installed Qwen Code extensions; manage the session-default extension
  list applied when a spawn doesn't specify `opts.extensions.only`.
- Plugin renamed from `qwen-coprocessor-stack` to `qwen-stack`.

### Removed

- Admin gate. Slash commands no longer require an opt-in flag; they
  enforce their own scope.

## [0.2.1] - 2026-05-05

### Added

- `/qwen-status` overview slash command — plugin version, supervisor
  process, build freshness, backends + health, env overrides, red flags.

## [0.2.0] - 2026-05-04

### Added

- `/qwen-stack:backends` slash command — backend lifecycle management,
  edits `~/.qwen-coprocessor-stack/config.json` in place; supervisor
  hot-applies on next spawn.
- Hot reload of the config file (mtime-cached) — no supervisor
  restart needed on config edits.

## [0.1.0] - 2026-05-04

### Added

- Initial release as a Claude Code plugin
  (`.claude-plugin/plugin.json`).
- MCP supervisor exposing `qwen_spawn / qwen_poll / qwen_send /
  qwen_stop / qwen_backends`.
- Multi-backend pool with KV-cache affinity per task_id.
- Per-spawn extension loadout (RDR-002): `opts.extensions: {enable?,
  disable?, only?}` wired through the qwen-extensions wrapper script.
