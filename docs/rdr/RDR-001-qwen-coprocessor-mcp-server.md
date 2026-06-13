---
name: Qwen-as-coprocessor — stateful Node MCP server with multi-backend routing
type: architecture
status: closed
priority: high
created: 2026-05-03
accepted: 2026-05-03
accepted_date: 2026-05-04
gate_passed_date: 2026-05-04
closed_date: 2026-05-04
close_reason: implemented
authors:
  - hal.hildebrand
reviewed-by: self
related:
  - RDR-002 (future — per-plugin catalogue: which plugins/agents/skills/commands/hooks live under plugins/, install order, scope decisions)
supersedes:
  - The original LiteLLM-gateway architecture (commits 9c97f49..25e8054). Retained
    on disk under `config/`, `mcp-bridges/claude-shim/`, `mcp-bridges/consult-claude/`,
    `claude-code/env.sh`, and `docker-compose.yml`. Not wired in.
---

# RDR-001 — Qwen-as-coprocessor: stateful Node MCP server with multi-backend routing

## Status

**Final — implemented (2026-05-04).** Accepted 2026-05-03; gate PASSED
2026-05-04 (Run 2; Run 1 BLOCKED on 2 CRITICAL critic findings, addressed
in remediation). All seven implementation phases (epic `ab6`, child beads
`ab6.1`–`ab6.7`) shipped. Legacy gateway code removed from disk in commit
`1fea01a`; the parallel stateless Python MCP removed in `39f8b93`. The
single delegation surface is now `mcp-bridges/qwen-agent-server/`
(commits `f3797a3` through `65ab205`).

Test status at close: 132 unit tests + 4 integration pins (3 SDK pins +
1 end-to-end round-trip) green against live llama-server, with ~98%
prefix-cache hit rate observed on turn 2 within a session.

The §Q1 mechanism originally proposed (deny-with-message answer
delivery via `canUseTool`) was empirically falsified during integration
testing (probe `/tmp/qwen-sdk-probe/probe-tool-result.mjs`, 2026-05-04).
The §Q1 section below was rewritten to reflect the corrected
mechanism — `ask_user_question` excluded from the inner Qwen's tool
surface, multi-turn input via streamInput async generator. RDR-001 is
the canonical reference for this design.

Supersedes the original gateway architecture documented in commits
`9c97f49..25e8054` and the README's "Subscription-billed escalation"
section through commit `89c4652`.

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
- **D6. Plugin parity is in-repo, not inherited.** Qwen Code's
  extension format claims compatibility with Claude Code plugins, but
  reliance on that compatibility surface couples our supervisor to
  upstream's translation layer. Instead, plugins, agents, skills,
  commands, and hooks for the inner Qwen are authored *in this repo*
  under `plugins/`, targeting Qwen Code's extension format directly.
  This gives us a stable, version-controlled extension fleet that
  evolves with the supervisor, independent of cross-platform compat
  weather.

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
| `qwen_spawn(task, opts?)`                    | `{ task_id, chosen_backend }`                        | Returns immediately. `opts` may include `backend` (explicit pin), `tier` (`local`/`remote`), `capacity` (`fast`/`heavy`), `write_authority` (default `false`), `allow_subagents` (default `false`), `prior_context` (for crash recovery — see S2 below), and `system` prompt override. |
| `qwen_poll(task_id, opts?)`                  | `{ state, recent_events, more_events_available, latest_event_id, last_message?, result?, error? }` | `state` ∈ `{running, idle, complete, error}`. After each turn the SDK emits a `result` message and the supervisor transitions `running → idle`; `last_message` carries the final assistant text from the turn (this is where plain-text questions surface). `opts.since` is an event-id cursor for incremental polling; `opts.max_events` caps the per-call payload (default 16). |
| `qwen_send(task_id, message)`                | `{ ack }`                                            | Pushes the next user turn into the session via the streamInput async generator. Wakes the generator's resolver so the SDK consumes the message and starts the next turn; `idle → running`. |
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
3. Classify task `capacity` need: `heavy` if approx token count
   ≥ `ROUTER_HEAVY_THRESHOLD_TOKENS` (default 2000) **or** the
   prompt matches any of `ROUTER_HEAVY_KEYWORDS` (default
   `prove,derive,architect,design`); otherwise `fast`. Filter pool
   to backends with matching `capacity`.
4. Drop unhealthy backends (cached `/health` probe, ~30 s TTL).
5. Pick from survivors by round-robin (or weighted, if `weight` set).
6. If no candidates, fall back to local; if local is also out, return
   `state: "error"`.

After spawn, the chosen backend is pinned in `QwenSession.backend` and
all subsequent SDK calls for that task use it. **No mid-conversation
backend migration.** Reasons:

- **Prefix-cache locality at the backend (verified ~98% hit rate).**
  llama-server caches KV state by prompt prefix. Within a session,
  every turn sends the growing message history via OpenAI Chat
  Completions; if every turn goes to the same backend, the prefix
  already-in-cache makes turn N+1's prompt-eval near-free. Spike A
  (`/tmp/qwen-sdk-probe/probe.mjs`, 2026-05-04) measured this
  empirically against our local llama-server:

  | Turn | input_tokens | cache_read_input_tokens | hit rate |
  |------|--------------|-------------------------|----------|
  | 1    | 16 964       | 16 448                  | 96.9%    |
  | 2    | 33 946       | 33 408                  | 98.4%    |

  Switching backends mid-conversation forces a full recompute on the
  new backend (turn 2 would pay ~33k tokens of prompt-eval cost
  instead of ~538). For a 27B model on Metal at ~127 tok/s prompt-eval,
  that's the difference between ~4 s and ~4.5 minutes of latency
  on the same turn. The SDK exposes `usage.cache_read_input_tokens`
  on each result — the supervisor can log this for visibility into
  whether affinity is actually helping per session.

  (Mechanism: this is a *backend* property, not an SDK-level
  optimisation; the SDK and underlying CLI send full context each
  turn over OpenAI Chat Completions, which is stateless on the
  wire. The cache benefit is real because the backend deduplicates
  prefixes server-side.)
- **Debuggability.** A whole conversation lives in one backend's
  logs. Splitting across backends fragments observability.
- **Simplicity.** Migration would require replaying the full history
  to the new backend on every switch, which is approximately equal in
  cost to the failure-recovery path described in S2 — so there's no
  speed benefit to migration during normal operation.

The cost is paid only when a backend dies mid-conversation (rare for
local infra), and the recovery path documented in S2 below handles it
explicitly.

Implementation layout:

```
mcp-bridges/qwen-agent-server/
├── package.json                # @modelcontextprotocol/sdk + @qwen-code/sdk
├── tsconfig.json
├── src/
│   ├── server.ts               # MCP server, 5 tools wired
│   ├── session.ts              # QwenSession state machine + SDK integration
│   ├── backends.ts             # Pool, router, health cache
│   ├── permissions.ts          # canUseTool callback (write_authority gating + denial events)
│   ├── shutdown.ts             # SIGTERM/SIGINT graceful close
│   └── types.ts                # shared types
└── dist/                       # build output; what we register with MCP

plugins/                         # in-repo extension fleet (per D6)
├── README.md                    # what's here, how it gets installed
├── nx-search-bridge/            # one extension per directory
│   └── extension.json           # Qwen Code extension manifest
├── serena-code-nav/
│   └── extension.json
├── context7-docs/
│   └── extension.json
└── (others — see RDR-002)
```

The supervisor's setup script (`scripts/setup-qwen-agent-server.sh`)
installs `plugins/*` into the isolated Qwen home (`~/.qwen` under
`CLAUDE_SHIM_HOME` equivalent for the agent server) before the first
`qwen_spawn`. Plugin choice and load order are in scope of RDR-002.

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

### Package identity and dependency-stability posture

The published package is **`@qwen-code/sdk`** (v0.1.7) — not
`@qwen-code/qwen-code-sdk`, which 404s on npm and was an early-draft
hypothesis. Self-described as *"a minimum experimental TypeScript
SDK"*. Bundles the CLI from v0.1.1 onward — `pathToQwenExecutable` is
auto-detected; the SDK manages the underlying subprocess transparently.

**Dependency-stability risk.** v0.1.7 is pre-1.0; the package
explicitly markets itself as experimental. Two consequences for our
architecture: (a) the API surface may shift in minor version bumps,
(b) bugs are likely in edge cases we haven't probed. Mitigations:
pin a specific version in `package.json`; `npm install` should never
auto-upgrade to a new minor; integration tests catch regressions on
deliberate bumps. The architectural decision to use the SDK rather
than the subprocess CLI directly remains correct because the
subprocess path's `stream-json` input direction is *also* officially
under construction — both paths carry upstream-stability risk; the
SDK's is at least typed and documented.

### Q1 (RESOLVED, empirically verified — REWRITTEN 2026-05-04 after spike falsification) — Multi-turn input via excluded `ask_user_question`

**Spike result that falsified earlier drafts.** An earlier draft of
this RDR claimed `canUseTool` was a single mechanism gating both
write-authority *and* `ask_user_question` answer delivery, with the
SDK's `{behavior: "deny", message: <answer>}` path delivering content
back to the model. A follow-up integration probe
(`/tmp/qwen-sdk-probe/probe-tool-result.mjs`, 2026-05-04) ran two
patterns end-to-end against the live llama-server:

| Pattern | Result | Explanation |
|---------|--------|-------------|
| `canUseTool` returns `{behavior: "deny", message: "BLUE-FOX"}` | ❌ FAIL — model says "user cancelled" | The model interprets the deny as cancellation with reason; not an answer. |
| `canUseTool` deny, then `streamInput` a `ToolResultBlock` whose `parent_tool_use_id` references the asked-for `tool_use_id` | ❌ FAIL — model treats it as orphaned | The deny closes the tool-call lifecycle from the model's POV; the late `tool_result` is dropped. |

Both candidate "answer-delivery" channels through `canUseTool` were
empirically broken. The original deny-with-message claim was
incorrect — earlier observations conflated the deny's `message`
*reaching* the model (which it does, as a cancellation reason) with
the model *treating it as an answer* (which it does not).

**Resolved mechanism: exclude `ask_user_question`; use streamInput
multi-turn for all input delivery.** The supervisor configures the
inner Qwen with:

- `excludeTools: ["ask_user_question", ...]` — the model never sees
  the tool. It cannot call it.
- A system-prompt preamble that tells the model: "the
  `ask_user_question` tool is not available; if you need
  clarification, ask in plain text in your response and stop. The
  user will reply on the next turn." (`COPROCESSOR_PREAMBLE` in
  `src/session.ts`.)
- An async-generator `prompt` argument to `query()` that yields
  `SDKUserMessage` items as the supervisor's `qwen_send(message)`
  pushes them. When the queue is empty the generator awaits a
  resolver; `qwen_send` flips that resolver to push the next turn.

**State machine, post-rewrite.** The `awaiting_input` state is
removed. After each turn, the SDK emits a `result` message; the
supervisor transitions `running → idle` and stays there until either
`qwen_send` (transition `idle → running`, deliver next user message)
or `qwen_stop` (transition to `complete`).

**Tool-category routing through `canUseTool`.** With
`ask_user_question` excluded, `canUseTool` is now a simpler callback
gating only write-authority:

| Tool category                          | Supervisor action |
|----------------------------------------|-------------------|
| `ask_user_question`                    | Excluded at the SDK level — never reaches the model. Defense-in-depth: if it somehow does (future SDK change, model bypass), `canUseTool` denies with a hint message and emits a `permission_denied` event. |
| Write tools, `write_authority: true`   | `permissionMode: 'yolo'` — `canUseTool` is not consulted. |
| Write tools, `write_authority: false`  | Resolve as `{behavior: "deny", message: "write_authority not granted"}` and emit synthetic `permission_denied` event into the session log. |
| Read tools (`read_file`, `grep_search`, `glob`, `web_fetch`, …) | `canUseTool` returns `allow` — non-blocking. |

Default `canUseTool` timeout is 60 s; the supervisor overrides to
600 s (10 min) via `QueryOptions.timeouts.canUseTool` to accommodate
slow tool-result paths even though the multi-turn answer path no
longer flows through `canUseTool`.

**Sources.** Empirical: `/tmp/qwen-sdk-probe/probe-tool-result.mjs`
(2026-05-04) — both deny-with-message and post-deny streamInput
ToolResultBlock failed. SDK type definitions:
`@qwen-code/sdk@0.1.7/dist/index.d.ts`: `SDKUserMessage`,
`Query.streamInput`, `QueryOptions.prompt` (`AsyncIterable<SDKUserMessage>`),
`CanUseTool`. Implementation:
`mcp-bridges/qwen-agent-server/src/session.ts` (`_inputGenerator`,
`_inputQueue`, `_inputResolver`, `send()`, `stop()`).

**Stability pin.** Pin 3 of `tests/integration/sdk-behavior.test.ts`
exercises the full multi-turn loop: turn-1 plain-text question, then
push the sentinel "BLUE-FOX" via streamInput, then assert turn-2
text references the sentinel. CI fails if the SDK or model changes
behavior so that streamInput follow-up messages stop being honored.

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
- `false` (default) → `permissionMode: 'default'` **with a registered
  `canUseTool` callback** that always returns
  `{behavior: 'deny', message: 'write_authority not granted'}` AND
  emits a synthetic `permission_denied` event into the session log.
  This preserves the read-only semantics while making denials visible
  to the supervisor (and via `qwen_poll`, to the caller). Without the
  callback, denials would be silent — the inner Qwen would believe its
  write succeeded and proceed on stale assumptions.
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
| Hard cap on concurrent live sessions | 3            | `QWEN_SUPERVISOR_MAX_SESSIONS`   |
| Idle TTL                             | 30 minutes   | `QWEN_SUPERVISOR_IDLE_TTL_MS`    |
| Reap sweep interval                  | 5 minutes    | (not exposed)                    |
| Eviction policy at cap               | LRU on `last_polled_at` | (not configurable)     |

The cap is set low because **VRAM is the binding constraint, not
session count**. Each live session pins a backend, and llama-server's
KV cache plus the model weights consume all the GPU memory available.
3 concurrent sessions covers single-developer use with one local
backend plus headroom for nested delegations; multi-developer or
multi-backend deployments raise the cap via the env var. The proxy-
class precedents (mehdic/claude-proxy at 4, meridian at 10) target
multi-tenant HTTP load and don't translate cleanly to local hardware.

LRU evictions surface as `task_id_not_found` errors; the caller
re-spawns (optionally with `prior_context` from the failure event,
see S2 below). No disk persistence at our scale.

### Operational design

The supervisor's polling, recovery, and shutdown semantics — explicit
to avoid leaving them implementation-defined.

#### Polling cadence and event payload (addresses S1)

`qwen_poll(task_id, opts?)` returns at most `opts.max_events` events
since the cursor `opts.since` (default 16 events, no cursor → most
recent). The response always includes:

- `state` — current state machine value
- `recent_events: Event[]` — bounded slice of events since cursor
- `latest_event_id: string` — pass back as `since` next call
- `more_events_available: boolean` — true if events were truncated

Events are categorical, not raw SDK messages: `{ id, type, ts,
summary, data? }` where `type` ∈ `{tool_call, tool_result,
permission_denied, model_message_summary, turn_complete, error}`.
The `data` payload is sized small — full assistant prose is replaced
with a one-sentence `summary`. This keeps `qwen_poll` returns from
inflating Claude's context with verbose model output Claude doesn't
need to see; if the caller wants the full prose it'll be in the
final `result` on completion.

Recommended polling cadence: **once per outer Claude turn**, not on
a wall-clock timer. The MCP loop is turn-by-turn anyway; polling more
often than that is wasted round-trips.

#### Backend failure recovery (addresses S2)

When a session's pinned backend becomes unreachable:

1. The session's next SDK call surfaces the error (HTTP refused,
   timeout, etc.).
2. Supervisor catches it, transitions session to `state: "error"`.
3. `qwen_poll` returns:
   ```ts
   {
     state: "error",
     error: { code: "backend_offline" | "backend_internal", message: string },
     last_known: {
       turns_completed: number,
       last_user_message: string,
       last_assistant_summary: string,
     },
   }
   ```
4. Caller decides: re-spawn elsewhere or surface to human. To
   re-spawn with context preserved:
   ```
   qwen_spawn(task, { prior_context: { conversation_summary: <last_known.last_assistant_summary>,
                                       last_user_message: <last_known.last_user_message>, ... } })
   ```
   The supervisor synthesizes a system-prompt prefix from
   `prior_context` so the inner Qwen knows what came before. Lossy
   for prior tool calls (which can't be replayed against a fresh
   backend), faithful for text content.

#### Graceful shutdown (addresses O3)

The Node MCP server registers `SIGTERM` and `SIGINT` handlers that:

1. Stop accepting new `qwen_spawn` requests immediately.
2. For each live `QwenSession`, call `query.close()` (or equivalent)
   and wait up to 5 s for in-flight model calls to complete cleanly.
3. Sessions still running after the timeout get a synthetic
   `state: "interrupted"` event in their log and are killed.
4. Process exits with code 0 if all sessions closed cleanly, 1 if
   any required forced kill.

Claude Code restarting the MCP server (the common case) loses all
in-process session state. Sessions that were `running` are orphaned;
`qwen_poll` against them returns `task_id_not_found`. Callers handle
this the same way they handle LRU eviction: re-spawn with
`prior_context` if continuity is wanted.

### Implementation map (consolidated)

| RDR field                  | Concrete API                                          |
|----------------------------|-------------------------------------------------------|
| Multi-turn input            | `query()` is invoked once per session with `prompt: AsyncIterable<SDKUserMessage>`. The supervisor's async generator yields the initial task immediately, then awaits an internal resolver that `qwen_send(message)` flips. Each `result` message ends a turn; supervisor transitions `running → idle` and the generator blocks until the next `qwen_send`. |
| Plain-text questions        | The system-prompt preamble (`COPROCESSOR_PREAMBLE`) instructs the inner Qwen to ask in plain text. The question text surfaces in the final assistant message of the turn, accessible via `qwen_poll.last_message`. The `ask_user_question` tool itself is in `excludeTools` and never reaches the model. |
| `canUseTool` timeout         | `QueryOptions.timeouts.canUseTool: 600_000` (10 min). Default 60 s is too tight even though `canUseTool` no longer carries the answer-delivery path — write-tool gates can still pause behind slow tool-result execution. |
| `opts.allow_subagents`      | `excludeTools: ['agent']` unless flag set             |
| `opts.write_authority`      | `permissionMode: 'default'` + denying `canUseTool` (visible) → `'yolo'` (full auto) |
| Tool surface                | Full default minus `agent` (unless overridden)        |
| Backend pool config         | One `query()` per task; SDK reads `OPENAI_BASE_URL` / `OPENAI_API_KEY` from `opts.env` per-call so we can pin a different backend per session |
| Hard cap                    | 3 concurrent sessions (override `QWEN_SUPERVISOR_MAX_SESSIONS`) |
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
