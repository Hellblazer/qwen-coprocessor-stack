---
name: Qwen-as-coprocessor — stateful Node MCP server with multi-backend routing
type: architecture
status: accepted
priority: high
created: 2026-05-03
accepted: 2026-05-03
authors:
  - hal.hildebrand
related:
  - RDR-002 (future — system prompt + tool restriction policy for the inner Qwen)
  - RDR-003 (future — observability hooks: pino + optional Langfuse)
supersedes:
  - The original LiteLLM-gateway architecture (commits 9c97f49..25e8054). Retained
    on disk under `config/`, `mcp-bridges/claude-shim/`, `mcp-bridges/consult-claude/`,
    `claude-code/env.sh`, and `docker-compose.yml`. Not wired in.
---

# RDR-001 — Qwen-as-coprocessor: stateful Node MCP server with multi-backend routing

## Status

**Accepted** (2026-05-03). Implementation pending. Supersedes the original
gateway architecture documented in commits `9c97f49..25e8054` and the
README's "Subscription-billed escalation" section through commit `89c4652`.

The formal `/nx:rdr-gate` review was not run; the project owner accepted
directly after architectural review. Open implementation questions
(captured below) are deferred to build time, not blockers for acceptance.

## Context

The repo's original architecture made Qwen the everyday workhorse and routed
hard-question escalation to Claude through a custom LiteLLM proxy. Claude
Code was redirected via `ANTHROPIC_BASE_URL` to the proxy, which dispatched
among five named routes by heuristic. That direction has two architectural
problems independent of any external constraint:

1. **It inverts the model-strengths gradient.** Claude is meaningfully
   better than Qwen at hard reasoning. Gating Claude behind heuristics
   that try to keep traffic off the more capable model is exactly
   backwards — it works against the actual capability differential.
   Putting Claude as orchestrator and delegating bulk/cheap work *to*
   Qwen matches the gradient instead of fighting it.
2. **It puts auth indirection in the request path.** Anthropic auth
   crosses a user-built proxy, which forces decisions about token
   handling, isolated config dirs, OAuth refresh paths, and
   subscription-vs-API-key flows that aren't intrinsic to the agent
   problem we're trying to solve. None of that complexity is necessary
   if the only thing reaching Anthropic's servers is the unmodified
   Claude Code client itself.

The flip — Claude at the top, Qwen as a coprocessor — sidesteps both.
A first-cut implementation already exists
(`mcp-bridges/qwen-coprocessor/server.py`) with four shaped tools:
`qwen`, `qwen_classify`, `qwen_summarize`, `qwen_extract`.

This RDR addresses what the *next* iteration looks like: a stateful agent
supervisor with multi-backend routing and conversational semantics, so
that delegating a multi-step coding task to Qwen feels like spawning a
sub-agent rather than calling a single function.

## Decision drivers

- **D1. No auth indirection.** No path routes Anthropic-bound traffic
  through user-built infrastructure. The unmodified Claude Code client
  is the only thing that reaches Anthropic's servers. This eliminates
  an entire class of problems (token refresh paths, isolated config
  dirs, multi-account state, third-party harness restrictions) that
  aren't intrinsic to the agent problem.
- **D2. Conversational delegation.** The interface should support
  multi-turn supervision — spawn a long-running task, poll progress,
  inject additional context mid-flight, cancel — not just one-shot
  request/response.
- **D3. Multi-backend routing with session affinity.** Local Qwen 27B
  today, remote Qwen 35B-A3B (Strix Halo) when that hardware lands,
  potentially additional sizes. Decisions about *where* a task runs
  belong in the supervisor; once a task is on a backend, it stays
  pinned there for KV-cache locality.
- **D4. State managed in our process.** Avoid stream-json subprocess
  parsing fragility (Qwen Code's stream-json input direction is
  documented as "currently under construction"). Hold conversation state
  as in-process objects.
- **D5. No infrastructure overhead beyond what's needed.** A single Node
  process plus llama-server. No Docker proxy unless it earns its
  keep through observability or features we genuinely use.

## Options considered

### Option A — Subprocess `qwen -p` per tool call (sealed box)

Implementation: an MCP tool `qwen_agent_run(task) → result` that
subprocess-spawns `qwen -p task --yolo`, captures stdout, returns it.

- ✅ Trivial: ~50 LoC Python
- ✅ Inherits Qwen Code's full toolset and prompt
- ❌ No bidirectional interaction during the call (any `ask_user_question`
  inside Qwen blocks indefinitely or is skipped under `--yolo`)
- ❌ State per call only; no notion of a long-running supervised task
- ❌ Pays subprocess startup cost (~5-10 s) per delegation
- ❌ Multi-backend routing has to happen via env var per-call; no shared
  health-check cache, no affinity model

### Option B — Subprocess `qwen --input-format stream-json --output-format stream-json`

Implementation: persistent Qwen Code subprocess per session, JSONL
turns over stdin, JSONL events over stdout. Supervisor parses the
event stream.

- ✅ Same shape as the `claude-shim` we already built; pattern is proven
- ✅ Persistent process amortizes startup cost
- ⚠️ **Officially "currently under construction" per Qwen's docs** for
  the *input* direction. Output direction works (we'd see all the tool-
  call events). Inbound message injection — the basis for `send_message`
  semantics — may be flaky or absent today.
- ❌ Brittle to upstream protocol changes
- ❌ Tool-call interception is string-parsing-flavored

### Option C — Node MCP server using `@qwen-code/sdk` (in-process)

Implementation: Node + TypeScript MCP server that imports Qwen Code's
official SDK as a library, holds `QwenSession` objects in a
`Map<task_id, QwenSession>`, exposes a supervisory tool surface to MCP
clients.

- ✅ State as objects, not parsed text. Tool events are first-class
  values from the SDK, not JSONL we have to disambiguate.
- ✅ No subprocess startup cost per task (only per Node process startup,
  which happens once at MCP client launch).
- ✅ Multi-backend routing lives in the supervisor with full task-level
  context (not just the LLM-level prompt LiteLLM would see).
- ✅ Session affinity is a single line: `session.backend = chosen` at
  spawn time.
- ✅ The SDK is the upstream-recommended path for this kind of programmatic
  control (Qwen Issue #874 acknowledged headless mode's tool-use
  reductions; SDK avoids that).
- ❌ Forces Node + TypeScript on us (the rest of the repo is Python-shell-bash).
- ❌ Two language ecosystems to maintain.
- ❌ Higher up-front investment than Option A.

### Option D — LiteLLM in front of multiple llama-server instances + Option A or C on top

Implementation: keep / restore the LiteLLM Docker container; point its
`model_list` at local + remote Qwen; route in LiteLLM; the MCP layer
talks to a single LiteLLM endpoint.

- ✅ LiteLLM gives observability hooks, fallback strategies, and a
  generic gateway for non-MCP clients
- ❌ The router only sees LLM-level prompts. It can't make decisions
  based on supervisor-level context (sub-agent depth, retry-on-failure,
  per-task tier hints from the MCP caller).
- ❌ Adds a Docker container to the active stack for routing among
  ≤3 homogeneous Qwen backends — over-engineered.
- ❌ More moving parts to debug.

## Decision

**Option C — Node MCP server using `@qwen-code/sdk`, with
multi-backend routing built into the supervisor and session affinity per
`task_id`.**

The supervisor exposes the following tool surface to MCP clients:

| Tool                                         | Returns                                              | Notes |
|----------------------------------------------|------------------------------------------------------|-------|
| `qwen_spawn(task, opts?)`                    | `{ task_id, chosen_backend }`                        | Returns immediately. `opts` may include `backend` (explicit pin), `tier` (`local`/`remote`), `capacity` (`fast`/`heavy`), and `system` prompt override. |
| `qwen_poll(task_id)`                         | `{ state, recent_events, awaiting_input?, result? }` | `state` ∈ `{running, awaiting_input, complete, error}`. Surfaces `ask_user_question` events as `awaiting_input` so the MCP client can route them to a human and answer via `qwen_send`. |
| `qwen_send(task_id, message)`                | `{ ack }`                                            | Injects text into the running session at the next tool-round boundary. |
| `qwen_stop(task_id)`                         | `{ ack }`                                            | Cancels and tears down the session. |
| `qwen_backends()`                            | `[{ id, url, model, tier, capacity, healthy }]`      | Discovery — lets the calling agent see what's available and bias selection. |

Multi-backend pool data model:

```ts
type Backend = {
  id:        string;                    // "local-27b", "remote-35b-a3b", …
  url:       string;                    // OpenAI-compat endpoint
  model:     string;                    // model name to send
  tier:      "local" | "remote";
  capacity:  "fast" | "heavy";
  weight?:   number;
};
```

Routing algorithm at `qwen_spawn`:

1. Explicit `opts.backend` pin wins.
2. Filter pool by `opts.tier` if given.
3. Classify task `capacity` need (`fast` vs `heavy`) by length and
   keyword markers; filter accordingly.
4. Drop unhealthy backends (cached `/health` probe, ~30 s TTL).
5. Pick from survivors by round-robin (or weighted, if `weight` set).
6. If no candidates, fall back to local; if local is also out, return
   `state: "error"`.

After spawn, the chosen backend is pinned in `QwenSession.backend` and
all subsequent SDK calls for that task use it. **No mid-conversation
backend migration** — KV-cache locality and debuggability outweigh any
load-balancing benefit.

Implementation layout:

```
mcp-bridges/qwen-agent-server/
├── package.json                # @modelcontextprotocol/sdk + @qwen-code/sdk
├── tsconfig.json
├── src/
│   ├── server.ts               # MCP server, 5 tools wired
│   ├── session.ts              # QwenSession state machine + SDK integration
│   ├── backends.ts             # Pool, router, health cache
│   └── types.ts                # shared types
└── dist/                       # build output; what we register with MCP
```

Registration:

```bash
claude mcp add --scope user qwen-agent-server \
  "node /path/to/mcp-bridges/qwen-agent-server/dist/server.js"
```

## Consequences

### Positive

- **Auth stays where it belongs.** The unmodified Claude Code client is
  the sole consumer of Anthropic credentials; Qwen is invoked locally
  via open-weights inference. Removes the token-handling complexity
  the gateway pattern accumulated.
- **Conversational by design.** Long-running tasks become first-class.
  Bidirectional interaction works through polling + `qwen_send`, no
  reliance on MCP elicitation (which has uneven client support) or ACP.
- **Routing in the right place.** Backend selection sees the full
  supervisor context — task tier hints from the caller, sub-agent
  depth, retry history — not just the LLM prompt.
- **Cleanly extensible.** New backends are config-line additions. New
  routing heuristics are pure-function changes in `backends.ts`. New
  MCP tools are file additions in `server.ts`.
- **Observability is opt-in but easy.** The Node server is a natural
  place to plug in `pino` for logs and a Langfuse client for trace
  events when wanted.

### Negative

- **Node/TypeScript is added to a Python-shell-bash repo.** Two language
  ecosystems. The build step (`tsc` → `dist/`) is now part of the
  install/dev loop.
- **No mid-conversation migration on backend failure.** If a session's
  pinned backend dies mid-task, the session fails and the caller has to
  re-spawn elsewhere. Migration was rejected for KV-cache reasons but
  the failure-mode is real.
- **Polling instead of push.** Acceptable in MCP and matches Claude
  Code's turn-by-turn model, but each `qwen_poll` is a tool round-trip.
  Heavy supervision (constant polling) inflates Claude's context with
  poll results.
- **The previous `qwen-coprocessor` Python MCP server (4 shaped tools)
  partially overlaps.** We'll need to decide whether to keep it
  alongside (different abstraction layer — fine-grained delegation
  primitives for cheap tasks vs. whole-task supervision via this new
  server) or retire it.
- **`ask_user_question` requires a different interception path from
  permission gating.** Resolved in research below — the supervisor
  watches the SDK message stream for `ToolUseBlock` with name
  `ask_user_question` and resumes via `query.streamInput()` with a
  `parent_tool_use_id` reference. Different mechanism from `canUseTool`
  for write-tool permission. Both must be implemented.

## Research findings

Findings from probing the SDK source directly (`@qwen-code/sdk` v0.1.7,
`dist/index.d.ts`, ~990 lines) and surveying analogous proxy
implementations (`mehdic/claude-proxy`, `rynfar/meridian`,
`CaddyGlow/ccproxy-api`).

### Package name correction

The SDK is published as **`@qwen-code/sdk`** (v0.1.7), not the
hypothesised `@qwen-code/sdk`. Self-described as *"a minimum
experimental TypeScript SDK"*. Bundles the CLI from v0.1.1 onward —
`pathToQwenExecutable` is auto-detected; the SDK manages the underlying
subprocess transparently. Our build can depend on this single package.

### Q1 (RESOLVED) — Awaiting-input signal

**Two distinct mechanisms, not one.**

- **Tool-permission gating (write tools, shell, etc.):** the SDK
  invokes a `canUseTool(toolName, input) → Promise<{allow, denyReason?}>`
  callback we register. Time the supervisor spends with that Promise
  unresolved is the supervisor's `awaiting_input` state for permission
  decisions. Default timeout 60 s (overridable via `timeouts.canUseTool`),
  fail-safe deny on timeout.

- **`ask_user_question` (model wants human input on a question):** the
  inner Qwen emits an `SDKAssistantMessage` whose `message.content[]`
  contains a `ToolUseBlock` with `name: "ask_user_question"` and `input`
  holding the question. The stream produces no further messages until
  we feed back a tool result. The supervisor must:
  1. Scan each `SDKAssistantMessage` for `ToolUseBlock` matching that
     name, capture `tool_use_id` and the question text.
  2. Set session state to `awaiting_input`; surface via `qwen_poll`.
  3. On `qwen_send(answer)`, call `query.streamInput()` with an
     `SDKUserMessage` whose `parent_tool_use_id === captured_id` and
     `message.content` is a `ToolResultBlock` containing the answer.
  4. Stream resumes; state returns to `running`.

Other `ToolUseBlock` names (file reads, shell commands when authorised,
etc.) are non-blocking — Qwen continues without supervisor input.

**Sources.** `@qwen-code/sdk@0.1.7/dist/index.d.ts`:
`SDKAssistantMessage`, `ToolUseBlock`, `ToolResultBlock`,
`Query.streamInput`, `CanUseTool`. Internal control plane uses
`CLIControlRequest{subtype: "can_use_tool"}` but that's not exposed on
the user-facing async iterable.

### Q2 (RESOLVED) — Tool restriction

`QueryOptions` exposes three orthogonal levers:
- `coreTools: string[]` — registry-level allowlist (only listed tools
  exist to the model).
- `excludeTools: string[]` — denylist, highest priority, supports shell
  prefix globs (`'ShellTool(rm )'`).
- `allowedTools: string[]` — auto-approve list, bypasses `canUseTool`.

The `agent` tool (Qwen spawning its own sub-agents) is in the default
15-tool surface and the SDK has **no built-in depth counter**. Unbounded
recursion is possible.

**Decision:** default `excludeTools: ['agent']` to prevent recursive
nesting. The supervisor *is* the orchestration layer; nested Qwen
sub-agents would be invisible to it. Expose opt-in
`opts.allow_subagents: true` that removes `agent` from the exclude list
for callers that genuinely need it. Do not use `coreTools` — it's
allowlist-shaped and harder to maintain than the denylist for "drop one
tool from an otherwise-full surface." Keep all other tools available.

### Q3 (RESOLVED) — Write-authority gating

`QueryOptions.permissionMode` is the programmatic equivalent of the
CLI's `--yolo` / `--approval-mode` flags. Four modes (priority chain
documented in `index.d.ts`):

| Mode        | Semantics                                                                |
|-------------|--------------------------------------------------------------------------|
| `default`   | Writes denied unless in `allowedTools` or approved by `canUseTool`. Reads run free. **No `canUseTool` provided + no `allowedTools` = effectively read-only.** |
| `plan`      | Blocks all write tools; model presents a plan first instead of executing. Different UX from "read-only." |
| `auto-edit` | `edit`/`write_file` auto-approved; shell/others ask via `canUseTool`. Files-but-not-shell middle ground. |
| `yolo`      | All tools execute without confirmation.                                  |

**Decision:** `opts.write_authority` flag on `qwen_spawn` maps to:
- `false` (default) → `permissionMode: 'default'`, no `canUseTool`,
  no `allowedTools`. Result: Qwen reads the world but writes are
  silently denied.
- `true` → `permissionMode: 'yolo'`. Full automation; caller is
  asserting it knows the cost.
- Future: optional `write_authority: 'edit-only'` → `'auto-edit'`.

Never default to `'yolo'`. Claude Code as the calling agent makes the
write-authority decision per-task and signals it explicitly.

### Q4 (RESOLVED) — Concurrent sessions and reaping

The SDK has no built-in pooling — that's our supervisor's responsibility.
Each `Query` owns one Node subprocess + one persistent HTTP connection
to the configured backend.

**Precedents** from analogous proxies:
- `mehdic/claude-proxy`: `CLAUDE_PROXY_POOL_MAX=4` default; LRU
  eviction at cap; idle TTL `CLAUDE_PROXY_POOL_TTL_MS=600000` (10 min);
  hard 6-min floor to avoid evicting inside Anthropic's 5-min prompt
  cache window.
- `rynfar/meridian`: `MERIDIAN_MAX_CONCURRENT=10`,
  `MERIDIAN_IDLE_TIMEOUT_SECONDS=120` (HTTP keepalive, distinct from
  session reaping).

**Decision:** revised down from the RDR's initial 16-concurrent.

| Setting                              | Default      | Override env                     |
|--------------------------------------|--------------|----------------------------------|
| Hard cap on concurrent live sessions | 8            | `QWEN_SUPERVISOR_MAX_SESSIONS`   |
| Idle TTL                             | 30 minutes   | `QWEN_SUPERVISOR_IDLE_TTL_MS`    |
| Reap sweep interval                  | 5 minutes    | (not exposed)                    |
| Eviction policy at cap               | LRU on `last_polled_at` | (not configurable)     |

LRU evictions surface as `task_id_not_found` errors; the caller
re-spawns. No disk persistence at our scale. The 6-min cache-window
floor doesn't apply to local Qwen backends (no equivalent server-side
prompt cache).

### Implementation map (consolidated)

| RDR field                  | Concrete API                                          |
|----------------------------|-------------------------------------------------------|
| Awaiting-input on tool perm | `canUseTool` callback Promise pending state           |
| Awaiting-input on question  | `ToolUseBlock.name === "ask_user_question"` scan + `query.streamInput()` resume |
| `opts.allow_subagents`      | `excludeTools: ['agent']` unless flag set             |
| `opts.write_authority`      | `permissionMode: 'default' | 'yolo'`                  |
| Tool surface                | Full default minus `agent` (unless overridden)        |
| Backend pool config         | One `query()` per task; SDK reads `OPENAI_BASE_URL` / `OPENAI_API_KEY` from `opts.env` per-call so we can pin a different backend per session |
| Hard cap                    | 8 concurrent sessions (override `QWEN_SUPERVISOR_MAX_SESSIONS`) |
| Idle TTL                    | 30 min (override `QWEN_SUPERVISOR_IDLE_TTL_MS`)        |

## Related decisions and prior art

- **Prior gateway architecture** (this repo, commits `9c97f49..25e8054`):
  retained on disk for reference; not wired in. Will be deleted when
  this RDR's implementation lands and stabilizes.
- **`steipete/claude-code-mcp`** — wraps `claude mcp serve` for
  programmatic invocation. Same shape pattern we want to mirror, but
  for Qwen.
- **`jeffery9/qwen-mcp-tool`** — Qwen MCP server with high-level tools
  (`ask-qwen`, `generate-code`, `review-code`, etc.). Different
  abstraction (tool-shaped helpers, not agent-supervisor). Complements
  rather than competes with this design.
- **`mehdic/claude-proxy`, `CaddyGlow/ccproxy-api`, `rynfar/meridian`** —
  community subprocess-pool / SDK-based proxies for Claude Code.
  Architecturally the closest analogues to what we're building.
- **`@qwen-code/sdk`** — Qwen's official TypeScript SDK; the
  upstream-recommended path for programmatic Qwen Code use.
- **Qwen Code Issue #874** — acknowledged that `qwen -p` headless mode
  uses fewer tools than interactive mode for the same prompt. SDK
  avoids this regression.

## References

- Qwen Code repo: https://github.com/QwenLM/qwen-code
- Qwen Code headless docs:
  https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/
- Qwen Code MCP-as-client docs:
  https://qwenlm.github.io/qwen-code-docs/en/developers/tools/mcp-server/
- Claude Code `mcp serve` docs:
  https://code.claude.com/docs/en/mcp
- LiteLLM (rejected for routing): https://github.com/BerriAI/litellm
