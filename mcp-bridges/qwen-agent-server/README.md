# qwen-agent-server

Stateful MCP supervisor that exposes a local Qwen Code inference stack as
a set of three MCP tools (`qwen_spawn`, `qwen_poll`, `qwen_send`, `qwen_stop`,
`qwen_backends`). The server routes tasks to one or more `@qwen-code/sdk`
backends, maintains per-session state machines, and surfaces async results via
a polling interface suitable for use inside Claude Code.

The server is intentionally minimal: it is a thin supervisor layer, not a
framework. All inference happens inside Qwen Code via the SDK; the server's
job is session lifecycle, backend routing, and the canUseTool permission gate.
See `docs/rdr/RDR-001` for the full architecture rationale.

---

## Quick start

**Step 1 — start the inference backend**

```bash
./scripts/start-stack.sh
```

This launches llama-server on `localhost:8080` running `qwen3.6-27b-instruct`.
The health endpoint at `http://localhost:8080/health` must return 200 before
the server can route traffic.

**Step 2 — build and install**

```bash
./scripts/setup-qwen-agent-server.sh
```

Idempotent. Runs `npm install` + `npm run build`, creates the Qwen home
directory (`~/.qwen-agent-server-home` by default), and prints the
registration command.

**Step 3 — register with Claude Code**

Copy and run the registration command printed by the setup script:

```bash
claude mcp add --scope user qwen-agent-server \
  "node /path/to/repo/mcp-bridges/qwen-agent-server/dist/server.js"
```

After registration, `qwen_spawn`, `qwen_poll`, `qwen_send`, `qwen_stop`,
and `qwen_backends` appear in Claude Code's MCP tool list.

---

## Configuration

All configuration is via environment variables passed to the server process.
The setup script and registration command can be prefixed with these.

| Variable | Default | Description |
|---|---|---|
| `QWEN_BACKENDS` | `[{"id":"local","url":"http://localhost:8080/v1","model":"qwen3.6-27b-instruct","tier":"local","capacity":"heavy"}]` | JSON array of `Backend` objects (see `src/types.ts`). Each entry requires `id`, `url`, `model`, `tier` (`"local"` or `"remote"`), `capacity` (`"fast"` or `"heavy"`). Optional: `weight` (default 1). |
| `QWEN_SUPERVISOR_MAX_SESSIONS` | `3` | Maximum concurrent active sessions. `qwen_spawn` returns an error if the cap is reached. |
| `QWEN_SUPERVISOR_IDLE_TTL_MS` | `1800000` | Milliseconds before an idle session (no `qwen_poll` activity) is evicted. Default = 30 minutes. |
| `ROUTER_HEAVY_THRESHOLD_TOKENS` | `2000` | Estimated token count above which the router prefers a `capacity:heavy` backend. |
| `ROUTER_HEAVY_KEYWORDS` | `prove,derive,architect,design` | Comma-separated prompt keywords that trigger routing to a `capacity:heavy` backend regardless of token count. |

Example with a remote Strix Halo box (Tailscale-reachable) joined to the
local Mac backend:

```bash
QWEN_BACKENDS='[
  {"id":"local-mac","url":"http://localhost:8080/v1","model":"qwen3.6-27b-instruct","tier":"local","capacity":"fast"},
  {"id":"strix","url":"http://your-strix-host:1234/v1","model":"qwen3.6-35b-a3b","tier":"remote","capacity":"heavy"}
]' \
  claude mcp add --scope user qwen-agent-server \
  "node /path/to/repo/mcp-bridges/qwen-agent-server/dist/server.js"
```

The router prefers `capacity:heavy` for prompts over
`ROUTER_HEAVY_THRESHOLD_TOKENS` or containing
`ROUTER_HEAVY_KEYWORDS`, falling back to `capacity:fast`. The `model`
field must match what `/v1/models` returns from each backend (for
llama-server it's the `--alias` value; for LM Studio it's the loaded
GGUF's identifier).

---

## Extensions

Per-spawn Qwen Code extension loadout (RDR-002). The orchestrator chooses
which extensions are active for each session via `qwen_spawn`'s
`opts.extensions` field. The SDK doesn't expose `extensions` in
`QueryOptions` directly — the supervisor bridges by setting
`pathToQwenExecutable` to a wrapper script (`scripts/qwen-extensions-wrapper.sh`)
that reads `QWEN_AGENT_EXTENSIONS` from env and prepends `--extensions <list>`
to the CLI's argv.

**Startup resolution.** The supervisor resolves the real `qwen` binary
once at startup. `QWEN_REAL_BIN` (env override, verified to exist and be
executable) takes precedence; otherwise `which qwen` is consulted. Either
miss is a fail-fast non-zero exit — an operator who hasn't installed Qwen
Code can't recover at first spawn, only by fixing the install.

**Per-spawn semantics.** `opts.extensions` accepts three optional
sub-fields:

| Field | Effect |
|---|---|
| `only: ['a','b']` | Exact-set semantics. `enable` and `disable` are ignored in this branch. Empty `only: []` disables all extensions for the spawn (`--extensions none`). |
| `enable: ['c']` | Additively unions onto the session-default base. |
| `disable: ['a']` | Subtractively removes from the session-default base after `enable`. `disable` wins on overlap. |

The session-default base is `QWEN_DEFAULT_EXTENSIONS` (a comma-list) when
set, otherwise the CLI's defaults (all enabled per
`extension-enablement.json`) — in which case the wrapper drops the
`--extensions` flag and the CLI inherits its own behaviour. Because the
supervisor cannot enumerate the implicit set, `enable`/`disable` without
either `QWEN_DEFAULT_EXTENSIONS` or `only` is rejected with a
`spawn_error` envelope rather than silently producing the wrong set.

Example — pin a session to one extension:

```jsonc
// qwen_spawn input
{
  "task": "Refactor the auth module",
  "opts": { "extensions": { "only": ["serena"] } }
}
```

Names match `config.name` from each extension's `qwen-extension.json`,
case-insensitive. Resolved unknown names produce a
`{ error: { code: "spawn_error", message: "unknown extension(s): X" } }`
envelope and no session is instantiated.

**Cache + reload.** The supervisor caches the installed-extension name
list at startup by parsing `qwen extensions list` output. Drain semantics
apply: in-flight sessions retain whatever set was resolved at their spawn
time; cache reloads only affect future spawns. Operators who install or
uninstall extensions while the supervisor is running can pick up the
change via the admin tool `qwen_reload_extensions` (registered only when
`QWEN_ADMIN_TOOLS=1` in env). See RDR-002 §Resolution-algorithm and
§Installed-extensions cache for the full design.

| Variable | Default | Description |
|---|---|---|
| `QWEN_REAL_BIN` | (resolved via `which qwen`) | Override for the real Qwen Code binary path. Verified at startup. |
| `QWEN_DEFAULT_EXTENSIONS` | unset (CLI defaults apply) | Comma-list of extension names that the supervisor uses as the session-default base when `opts.extensions.only` is unset. |
| `QWEN_ADMIN_TOOLS` | unset | Set to `1` to register the admin-only `qwen_reload_extensions` MCP tool. |

---

## SDK pin policy

`@qwen-code/sdk` is pinned **exact** to `0.1.7` in `package.json`. This is
intentional and must not be bumped without running the integration test suite
against a live backend.

**Why exact?** RDR-001 §Q1 documents that the deny-with-message path
(`{ behavior: 'deny', message: '<answer>' }` in `canUseTool`) is the proven
mechanism by which `ask_user_question` answers are delivered back to the model.
This is empirically verified (see `/tmp/qwen-sdk-probe/probe.mjs`, Spike B,
2026-05-04) but is not part of the SDK's public API contract. A patch or minor
release could silently change it.

Similarly, KV-cache affinity depends on the SDK preserving context across turns
within one `query()` call. The session layer pins `session.backend` at
construction and never reassigns it (§Q3 KV-cache affinity) — but an SDK
change to connection management could break cache locality invisibly.

**Gate before bumping:**

```bash
# 1. Ensure llama-server is running
curl -sf http://localhost:8080/health

# 2. Run the integration suite
cd mcp-bridges/qwen-agent-server
npm run test:integration
```

If **any** of the three SDK pin assertions fail, do **not** bump the SDK.
File a report against RDR-001 and investigate whether the fallback paths
documented there cover the regression before proceeding.

The three pin tests are in
`tests/integration/sdk-behavior.test.ts`.

---

## Development

```bash
cd mcp-bridges/qwen-agent-server

# Unit tests (no backend required)
npm test

# Integration tests (requires llama-server on :8080)
npm run test:integration

# Build
npm run build

# Run directly (after build)
node dist/server.js
```
