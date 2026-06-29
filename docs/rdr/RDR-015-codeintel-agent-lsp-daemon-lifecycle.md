---
title: "codeIntel agent-lsp daemon lifecycle — adopt agent-lsp's per-(root,language) daemon-broker for warm start_lsp reuse across spawns, and bound its accumulation"
id: RDR-015
type: Design
status: draft
priority: medium
author: hal
reviewed-by: pending
created: 2026-06-28
related_issues: []
---

# RDR-015: codeIntel agent-lsp daemon lifecycle

> Revise during planning; lock at implementation.
> If wrong, abandon code and iterate the RDR.

## Status

**Draft (2026-06-28).** Follow-up to RDR-014 (closed, shipped v0.11.13) and its
guidance hardening (PR #77/#78, v0.11.14). RDR-014 shipped `opts.codeIntel` as
an **opt-in** that injects an `agent-lsp` stdio `mcpServers` entry per spawn.
The user has now stated codeIntel is going **first-class / frequent**, which
surfaces a lifecycle question RDR-014 never addressed: every spawn's fresh
`uvx agent-lsp` requires a per-root `start_lsp` (+ a full LSP index), and that
cost — paid every spawn, per root — does not scale to frequent use.

## Problem Statement

`find_symbol` (and the other nav tools) require `start_lsp(root_dir, language)`
first, and `start_lsp` cold-starts a language server and indexes the workspace.
For TypeScript/JVM servers (tsserver, jdtls) indexing dominates wall-clock. If
each codeIntel spawn launches its own agent-lsp and re-indexes from cold, then:

- **per-spawn latency** is dominated by re-indexing the same roots repeatedly;
- **concurrent footprint** = N spawns × per-root brokers × language-server
  processes (jdtls is a JVM), competing for RAM with the served model on the
  capacity-constrained box (~96 GB GPU carveout) / Mac (`-w1` MLX).

The question raised: *do we need to manage the lifecycle of the per-root
`start_lsp` / agent-lsp if we are going to use it as a first-class tool?*

## Context

- **RDR-013 trust/forwarding model (locked):** the supervisor only *forwards*
  `opts.mcpServers` into the inner qwen-code agent via the SDK control protocol;
  it never touches the spawned process. The qwen-code CLI (spawned by
  `@qwen-code/sdk`) owns the stdio `agent-lsp` child. Supervisor teardown is
  `session.stop()` → `_abortController.abort()` + `sdkIter.return()`
  (`src/session.ts:381`). We have no direct handle on agent-lsp or its children.
- **RDR-014 (shipped):** `applyCodeIntel` (`src/server.ts`) synthesizes the
  agent-lsp entry (`command:"uvx", args:["agent-lsp"], cwd: opts.cwd ?? cwd`,
  `includeTools` scoped to 10 nav tools), guidance, and `max_tool_calls=12`.
- **v0.11.14 guidance fix (shipped):** the system prompt now tells the model to
  call `start_lsp` first with `root_dir` = the manifest dir, `ready_timeout`,
  and to open a file before `find_symbol`. This makes the **cold path correct**;
  it does nothing about **repeated** cold cost. This RDR is the durable answer.

## Decision

**Tentative (pending gate).** agent-lsp already ships the warm-reuse mechanism
we would otherwise have to build — a persistent per-(root,language)
**daemon-broker** (see Research Finding 1, VERIFIED). The broker already
survives our session teardown, so cross-spawn warm reuse works **today** with no
supervisor change. The actual work is therefore *not* "build a shared service"
and *not* "make it persist" — it is **bound the accumulation** the persistence
creates, plus optionally amortize the very first cold start.

### In scope (proposed — to be locked at gate)

1. **Adopt the daemon-broker as the warm-reuse substrate** — document and rely
   on it; do NOT change teardown to kill brokers (that would defeat reuse).
2. **Idle reaping** — add a sweeper that stops brokers whose `last_activity`
   (recorded in `daemon.json`) exceeds an idle TTL, via the agent-lsp-provided
   `agent-lsp daemon-stop --root-dir=X --language=Y` command (which cascade-kills
   the LSP child — "LSP server … did not exit after 3s, killing"). Host it in the
   existing keepalive LaunchAgent (`scripts/ops/keepalive-coprocessor.sh`), not
   the supervisor (the broker outlives any one supervisor session).
3. **Concurrency / footprint bound** — a cap on resident brokers (LRU-stop the
   coldest) so jdtls JVMs cannot accumulate without limit on the box/Mac.

### Out of scope (proposed)

- Building our own agent-lsp pool / shared HTTP service — agent-lsp's daemon
  already is one (YAGNI; same posture as RDR-014).
- Pre-warming every repo at boot — pre-warm only an explicit hot-repo list, if
  at all (deferred to a follow-up unless research shows first-cold dominates).
- Committing `.agent-lsp/cache.db.gz` into target repos — a per-repo decision,
  not a supervisor concern; note it as an operator recipe only.

### Bright line (proposed)

The supervisor's teardown contract is **unchanged**: it still does not touch the
agent-lsp process tree (RDR-013). Broker lifecycle is owned by agent-lsp + an
**ops-side** reaper, never by the per-session abort path.

### Approach (proposed — numbered for phase-review cross-walk)

1. Verify broker survival + reaping mechanics against the live tool — **DONE**
   (Research Finding 1).
2. Decide idle-TTL + resident-broker cap values from a footprint measurement
   (jdtls/tsserver RSS × realistic concurrency on box/Mac).
3. Implement the ops-side reaper in the keepalive (idle sweep + LRU cap),
   guarded like the rest of that script (every `kill` guarded; `daemon-stop`
   preferred over raw kill so the LSP child is reaped).
4. Optionally set `AGENT_LSP_BROKER_TIMEOUT_MS` in `applyCodeIntel`'s agent-lsp
   `env` (start-timeout headroom for large cold repos — NOT an idle knob).
5. Optionally pin an installed `agent-lsp` over `uvx agent-lsp` to drop the
   per-spawn resolve; weigh against the RDR-014 "prereq not installed by us".
6. Docs: USER_GUIDE warm-reuse + cache recipe; ARCHITECTURE broker-ownership +
   the unchanged teardown bright line.

## Research Findings

### Finding 1 — daemon-broker survives teardown; no idle reaping (VERIFIED 2026-06-28)

Probed against live `uvx agent-lsp` (v0.15.x) via a minimal MCP stdio client:
`start_lsp(root_dir, ts, ready_timeout)` → `list_symbols` → `find_symbol`
(resolved `chooseBackend` @1.00), then closed the client and re-checked.

- **Survival CONFIRMED.** After client close, `agent-lsp daemon-broker
  --root-dir=… --language=typescript --command=typescript-language-server,--stdio`
  and its `node typescript-language-server --stdio` child stay alive. Registry:
  `~/.cache/agent-lsp/daemons/<hash>/{daemon.json,daemon.pid,daemon.sock}`,
  keyed by a hash of (root_dir, language) → a **per-(root,language) singleton**.
  `daemon.json` records `root_dir`, `language_id`, `command`, `socket_path`,
  `pid`, `ready`, `start_time`, `last_activity`. The stdio `uvx agent-lsp` is a
  thin **client**; the broker is a detached, socket-registered process. ⇒ warm
  cross-spawn reuse works **today**; our `abort()`-based teardown correctly does
  not kill it, and must stay that way.
- **Manual reap exists; automatic idle-reap UNDER MEASUREMENT (Finding 1 self-correction).**
  `AGENT_LSP_BROKER_TIMEOUT_MS` is the broker *start* timeout (`brokerStartTimeout`
  / "broker did not start within %s"), NOT an idle TTL. A manual reap exists:
  `agent-lsp daemon-stop --root-dir=X --language=Y` (binary: `StopDaemon`,
  `stop_daemon_unix.go`, "terminating daemon PID %d"; it cascade-kills the LSP
  child — "LSP server … did not exit after 3s, killing").
  **CORRECTION (2026-06-28):** the original "LEAK CONFIRMED — orphaned
  typescript-language-server up to 4d10h" claim was **misattributed**. Those
  processes are children of `claude` (Serena/Claude Code's own LSP integration),
  **not** agent-lsp brokers — verified via `ps -o ppid`. Meanwhile the broker
  from the original probe (created ~18:44) was **gone by ~19:14** (registry dir
  mtime), with no client connected — i.e. it self-terminated after ~30 min idle,
  which would mean agent-lsp **does** self-reap (the binary carries `idleTimeout`
  / `onIdleTimeout` symbols, mixed with library noise). This is now being
  measured directly (detached idle-watch on a fresh broker, no client) to
  establish whether a self-reap exists and its interval. **Until that resolves,
  the "unbounded accumulation" premise is NOT established** and the In-scope
  reaper (items 2–3) is provisional — if agent-lsp self-reaps on a sane idle
  TTL, the supervisor/ops side may need only a resident-cap backstop, or nothing.
- **Persistent symbol cache** exists separately at `~/.agent-lsp/cache/`
  (committable as `.agent-lsp/cache.db.gz` — "teammates skip cold-start
  indexing"); amortizes cold-start across daemon restarts/machines.

Repro: drive agent-lsp over an MCP stdio client (`@modelcontextprotocol/sdk`),
inspect `~/.cache/agent-lsp/daemons/*/daemon.json` and `ps -o pid,etime,rss`.
bd memory: `codeintel-agentlsp-daemon-lifecycle-2026-06-28`,
`codeintel-roughedge-rootcause-2026-06-28`.

## Consequences

### Positive

- Warm cross-spawn `start_lsp` reuse is **already available** — first-class use
  pays per-root indexing once, not per spawn. No new shared-service to build.
- Reaping is a small, ops-side addition using an agent-lsp-provided command,
  consistent with the existing keepalive's "own the lifecycle out-of-band" model.

### Negative

- **IF** agent-lsp does not self-reap on a sane idle TTL (under measurement —
  see Finding 1 correction), frequent codeIntel use could accumulate brokers +
  JVMs and starve the served model of RAM. The original "measured leak" evidence
  was retracted (misattributed to Claude/Serena's LSP servers), so this is a
  risk to confirm, not an established fact.
- Any reaper we add introduces host-state coupling (the keepalive must know
  agent-lsp's registry path + `daemon-stop`) — a new ops surface; only worth it
  if the self-reap measurement shows a real gap.

### Neutral

- The supervisor stays out of broker lifecycle entirely (RDR-013 bright line
  intact); all lifecycle logic lives in agent-lsp + the keepalive.
- codeIntel posture stays opt-in until the reaper ships; first-class use is a
  resourcing decision gated on the footprint measurement (Approach 2).
