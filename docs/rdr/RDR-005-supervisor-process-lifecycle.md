---
title: "Supervisor process lifecycle — layered cleanup model"
id: RDR-005
type: Architecture
status: deferred
priority: high
author: hal
reviewed-by: self
created: 2026-05-20
accepted_date: 2026-05-20
deferred_date: 2026-05-21
related_issues: [qwen-coprocessor-stack-huy]
---

# RDR-005: Supervisor process lifecycle — layered cleanup model

> **Status update 2026-05-21 — DEFERRED.** A1 spike (bead `huy`) refuted
> the in-session double-spawn premise: two `/reload-plugins` cycles in a
> live session produced zero new supervisors. A bonus `kill -9` test on a
> parent claude process also reaped its supervisor child cleanly (stdin
> EOF closes the child via existing Node stdio handling) — refuting the
> Gap 2 orphan-accumulation premise as well. The "5 supervisor pile"
> observed on 2026-05-20 was re-interpreted as 5 active claude sessions
> with 1 supervisor each (correct 1:1 accounting), not a pile-up. Current
> behavior handles all tested termination scenarios. Implementation beads
> deferred. Edge cases not yet tested (`kill -STOP` parent, supervisor
> busy in tool call when parent dies) could revive the work if they ever
> reproduce in practice. Findings: T2 entry
> `qwen-coprocessor-stack_rdr/005-research-02-a1-reload-spike`.

> Revise during planning; lock at implementation.
> If wrong, abandon code and iterate RDR.

## Problem Statement

The qwen-stack MCP supervisor (`mcp-bridges/qwen-agent-server/dist/server.js`)
is spawned by Claude Code as a stdio MCP child of each Claude session.
Over time, supervisor processes accumulate:

- 5 live `node …/server.js` processes observed on this host on 2026-05-20,
  with ages ranging from ~2.5 h to >2 days.
- Each is parented to a live `claude --resume <uuid>` process — so no
  process is orphaned by ppid, but the pile is still anomalous.
- A separate Claude Code instance recently **hung while updating the
  qwen plugin**; the user had to ^C it. The wedged supervisor was
  parented to a live `claude` but no longer responding on stdio.
- `/reload-plugins` has been observed to spawn a new MCP child without
  reliably reaping the previous one — an in-session leak distinct
  from the cross-session pile.

The MCP transport is stdio-coupled to the parent `claude`. When the
parent exits cleanly, the child receives stdin EOF + SIGTERM and exits.
But under SIGKILL, OOM, lost hooks, `/reload-plugins` races, or wedged
internal state, the child can survive its useful lifetime.

### Enumerated gaps to close

#### Gap 1: In-session double-spawn from /reload-plugins

A `/reload-plugins` cycle in a single Claude session can spawn a fresh
supervisor without reaping the previous one. Both children remain
parented to the same `claude` pid; only one is the active MCP peer.
The orphan accumulates idle stdio and resources until the parent exits.

#### Gap 2: Cross-session stale pile self-heals only by host reboot

Each ungraceful Claude exit (SIGKILL, OOM, host sleep weirdness, panel
force-close) can leave a supervisor running. Nothing reaps them on the
next supervisor boot, so the pile grows monotonically until a manual
`pkill` or reboot.

#### Gap 3: Wedged-supervisor case (parent alive, stdio dead)

A supervisor whose internal state has wedged (deadlock, hung llama.cpp
request, JS event-loop block) continues to satisfy ppid-aliveness checks
but no longer services MCP. The parent Claude session may hang waiting
for a response; there is no programmatic way to identify or recover
the wedged child without killing it manually.

#### Gap 4: Shutdown path is single-hook and not idempotent

Current cleanup relies on stdin EOF / SIGTERM propagation alone. There
is no pidfile, no signal-handler+atexit chain, no SessionEnd hook —
so any path that bypasses normal SIGTERM (kill -9, panel force-close,
parent OOM) leaves no recoverable bookkeeping.

## Context

### Background

Surfaced during the 2026-05-20 session while triaging a hung peer
instance. `ps -eo pid,ppid,etime,command | grep server.js` revealed
the 5-supervisor pile. The user explicitly asked us to consult prior
art in the nexus repo, which had hit a structurally identical class
of bug with the T1 scratch chroma server lifecycle.

The nexus precedent (see [References](#references)):

- **RDR-105** introduced `t1_addr.<claude_pid>` pidfiles plus
  `sweep_orphan_t1_addr_files()` at MCP startup
  (`src/nexus/session.py:768-792`, `src/nexus/mcp/core.py:179-210`).
- **RDR-094** documented that **SessionEnd hooks alone are not
  load-bearing** — SIGKILL, OOM, hook loss, and stdin-EOF/SIGTERM
  races require multiple converging cleanup paths
  (`tests/test_plugin_structure.py:501-527`,
  `src/nexus/mcp/core.py:305-338`).
- Early nexus designs tried walking PPID up to a `claude*` ancestor to
  key sessions; that scheme silently broke isolation in owned-subprocess
  modes (`src/nexus/session.py:586-620`, RDR-105 RF-6). Current scheme
  uses UUID-keyed session records, with ppid only used to *discover*
  which UUID to bind to.
- `_SHUTDOWN_IN_FLIGHT` guards the stdin-EOF / SIGTERM race because
  both paths fire and idempotence is required.

The lesson, restated: **cleanup is layered, not single-shot.** A
pidfile alone or a sweep alone or a SessionEnd hook alone all fail in
documented cases. The combination converges.

### Technical Environment

- Supervisor: Node 22+ TypeScript MCP server, `mcp-bridges/qwen-agent-server`.
- Transport: stdio (MCP framework over stdin/stdout to parent `claude`).
- Host: macOS (darwin 25.4.0); BSD `ps`. Linux portability matters
  (CI / Linux dev hosts) but BSD `ps` flags differ.
- No existing pidfile, signal handler, or admin tool.
- `/reload-plugins` is a Claude Code mechanism, not under our control.
- Three local `llama-server` backends on :8080/:8081/:8082 plus a
  remote `qwentescence` backend — none implicated by this RDR.

## Research Findings

### Investigation

Reviewed nexus code via `mcp__plugin_nx_nexus__search` for the T1
session lifecycle pattern (sessions covered above). Read the
TypeScript supervisor surface to identify where startup, shutdown,
and signal handling live today (TBD during implementation — see
Assumption A2).

#### Dependency Source Verification

| Dependency | Source Searched? | Key Findings |
| --- | --- | --- |
| Node `process` | Docs Only | `process.on('SIGTERM'|'SIGINT')`, `process.on('exit')`, `process.pid`, `process.ppid` standard. Verify async-cleanup limits during impl. |
| nexus T1 lifecycle | Yes | RDR-105 pidfile + sweep; RDR-094 multi-path idempotent shutdown; `_SHUTDOWN_IN_FLIGHT` race guard. |
| MCP stdio framing | Documented | Parent stdin-close is normal exit signal; child must not exit on transient idle. |

### Key Discoveries

- **Documented**: Each Claude session legitimately spawns one MCP
  child. The "5 supervisors" observation is *expected* given 5 live
  Claude sessions on this host — *if* there's no in-session leak.
  Confirmed by 1:1 ppid mapping on 2026-05-20.
- **Documented (nexus)**: PPID-walk session keying breaks silently in
  owned-subprocess modes. We **must not** use ppid as a session
  identity — only as a discovery hint.
- **Documented (nexus)**: Single-hook shutdown loses on SIGKILL/OOM.
  Layered cleanup (pidfile + startup sweep + signal handler + atexit)
  converges where any single path fails.
- **Assumed**: `/reload-plugins` in Claude Code does not always send
  SIGTERM to the prior child before spawning a new one. Needs a
  reproducer (Spike S1) before claiming the in-session leak is real
  and not a confounded observation.
- **Assumed**: BSD `ps -o ppid= -p <pid>` is reliable for liveness +
  parent identity checks on macOS; Linux `procfs` is more direct.
  Implementation needs a thin portable wrapper.

### Critical Assumptions

- [ ] A1: `/reload-plugins` can spawn a new supervisor without SIGTERM
      to the previous one — **Status**: Deferred to spike bead
      `qwen-coprocessor-stack-huy` — **Method**: Spike.
      Gates Gap 1 framing; if spike refutes, Gap 1 collapses into Gap 2
      and the duplicate-refuse layer becomes optional. Spike must
      complete before Phase 1 Step 4 (server.ts wiring).
- [x] A2: The current supervisor has no existing pidfile, signal
      handler, or SessionEnd hook that conflicts with this design —
      **Status**: Verified (2026-05-20) — **Method**: Source Search
      (`mcp-bridges/qwen-agent-server/src/{server.ts,shutdown.ts}`).
      Finding: `setupShutdown` in `src/shutdown.ts:36-103` already
      provides the idempotent-handler scaffold with SIGTERM+SIGINT
      wired at `src/server.ts:1303-1316`. Missing pieces match this
      RDR's Layers 1/2/4 exactly plus `stdin.end` + `exit` handlers
      in Layer 3. No conflicts; extend rather than rewrite.
      See T2 memory `005-research-01-a2-source-audit`.
- [ ] A3: Process liveness via `kill(pid, 0)` (Node) reliably
      distinguishes alive vs. dead on macOS+Linux for non-zombie
      processes — **Status**: Documented — **Method**: Docs Only
      (acceptable: standard POSIX)
- [ ] A4: A wedged-but-alive supervisor can be detected via stdio
      heartbeat absent N minutes of MCP traffic — **Status**:
      Unverified — **Method**: Spike

**Method definitions**:

- **Source Search**: API verified against dependency source code.
- **Spike**: Behavior verified by running code against a live system.
- **Docs Only**: Documentation reading alone (insufficient for
  load-bearing).

## Proposed Solution

### Approach

Adopt the nexus T1 layered cleanup model, adapted to the qwen-stack
supervisor's TypeScript+stdio context. **Identity rule (from nexus
RDR-105 RF-6):** the supervisor's identity key is a generated UUID,
not its parent pid. `process.ppid` is used only as a *discovery hint*
to find candidate pidfiles, never as an identity.

1. **UUID-keyed pidfile with atomic create.** On supervisor startup,
   generate a fresh UUID and **atomically** create
   `$RUN_DIR/supervisor.<uuid>.pid` via `fs.promises.open(path, 'wx')`
   (`O_CREAT|O_EXCL`). File contents:
   ```text
   <supervisor_pid> <claude_ppid> <iso8601_startup> <node_version>
   ```
   Refuse-duplicate is a *secondary* check on **already-running peers**,
   not a write-time race: after our own file is created, scan sibling
   `supervisor.*.pid` files; if any names the same `claude_ppid` AND
   the recorded supervisor pid is alive AND its `comm` matches our
   supervisor binary, exit cleanly with a "duplicate-for-parent" log.
   The UUID-keyed filename eliminates the TOCTOU window (every
   process has a unique filename; collisions are impossible).
2. **Startup sweep.** Before the duplicate check, walk
   `$RUN_DIR/supervisor.*.pid` and remove any file whose recorded
   `claude_ppid` is dead, OR whose recorded supervisor pid is dead,
   OR whose recorded supervisor pid names a non-supervisor process
   (pid-reuse). Best-effort SIGTERM to truly-orphaned supervisors
   (parent dead, child alive) before unlinking their file.
3. **Idempotent shutdown chain.** Extend existing
   `setupShutdown()` (see Existing Infrastructure Audit) with an
   `onShutdown` callback invoked **before** session-pool draining,
   so the pidfile is unlinked even if pool drain times out and forces
   `exit(1)`. Wire four entry points to `handleSignal`:
   - `SIGTERM`, `SIGINT` (existing — async cleanup)
   - `process.stdin.on('end')` (new — async cleanup, MCP transport EOF)
   - `process.on('exit')` (new — **sync-only** `unlinkSync` of own
     pidfile as last-ditch fallback; never `await` here, Node drops
     async listeners on this event)

   The existing `shutdownStarted` flag ensures idempotence across all
   four entry points.
4. **Admin escape hatch.** New `/qwen-stack:supervisor-clean` skill +
   `scripts/supervisor-clean.ts`. Categorizes supervisors into three
   buckets with distinct visual treatment:
   - **Orphan** (parent dead, supervisor alive) — recommended for kill
   - **Stale** (parent dead, supervisor also dead, pidfile lingers)
     — recommended for file removal only
   - **Live peer** (parent alive, supervisor alive, MCP responsive)
     — display only; refuse kill without a `--force` flag and an
     explicit "this is a working supervisor for live session
     `<claude_pid>`" warning.
5. **(Deferred to follow-up RDR)** Liveness heartbeat to detect
   wedged-but-alive supervisors (Gap 3). Out of MVP scope.

**Run directory selection** (S1 fix): use `$XDG_RUNTIME_DIR/qwen-coprocessor-stack/`
when the env var is set (tmpfs, systemd-cleaned, container-scoped).
Fall back to `$HOME/.qwen-coprocessor-stack/run/` otherwise, with a
documented caveat that NFS-mounted homes may give inconsistent
`kill(pid, 0)` semantics and container PID-namespace resets can
produce false-positive liveness via pid reuse — the `comm` check in
sweep + refuse-duplicate mitigates the latter.

### Technical Design

**Run directory selection:**

```text
RUN_DIR = $XDG_RUNTIME_DIR/qwen-coprocessor-stack/        if XDG_RUNTIME_DIR set
        = $HOME/.qwen-coprocessor-stack/run/              otherwise
```

Created with mode 0700 if absent. Path resolution runs once at
supervisor startup; cached on `globalThis` for shutdown handlers.

**Pidfile contract** — UUID-keyed filename, fixed-format body:

```text
filename: supervisor.<uuidv4>.pid
body (one line, space-separated):
<supervisor_pid> <claude_ppid> <iso8601_startup> <node_version> <comm>
```

UUID guarantees per-process uniqueness; `claude_ppid` lives in the
body for sweep+refuse-duplicate filtering. `comm` (process name) is
recorded so sweep can detect pid-reuse.

**Discovery / sweep API** (`src/lifecycle.ts`):

```text
// Illustrative — verify Node fs.promises signatures during implementation
function resolveRunDir(): string                                  // XDG-or-HOME
function writePidfileExclusive(): Promise<{path: string; uuid: string}>
                                                                  // fs.open(p,'wx');
                                                                  // body includes own comm
function readPidfile(path: string): Promise<PidfileRecord | null>
function isProcessAlive(pid: number): boolean                     // kill(pid, 0)
function commOf(pid: number): Promise<string | null>              // ps -o comm= / /proc
function sweepStalePidfiles(): Promise<{removed: string[]; siKilled: number[]}>
function findLivePeer(claudePpid: number, ownUuid: string):
        Promise<{pid: number; uuid: string} | null>               // duplicate check
function categorizeSupervisor(rec: PidfileRecord):
        'live-peer' | 'orphan' | 'stale'
```

**Shutdown chain extension** — `src/shutdown.ts:setupShutdown` takes
an additional `onShutdown` callback, invoked **before** pool drain:

```text
// Illustrative — extends existing src/shutdown.ts:36-103
export function setupShutdown(
  server: ShuttableServer,
  pool: SessionPool,
  exit: (code: number) => void = process.exit,
  onShutdown: () => Promise<void> = async () => {},   // NEW
): { handleSignal; isShuttingDown }

// inside handleSignal, before pool drain:
try { await onShutdown(); } catch (err) { log.error({err}, "onShutdown failed"); }
```

**Startup wiring** (`src/server.ts`) — order matters:

```text
// Illustrative; current SIGTERM/SIGINT wiring at server.ts:1303-1316
1. const runDir = resolveRunDir(); ensureDir(runDir, 0o700);
2. await sweepStalePidfiles();                       // reap dead siblings
3. const { path: pidfilePath, uuid } =
       await writePidfileExclusive();                // O_EXCL — no race
4. const peer = await findLivePeer(process.ppid, uuid);
   if (peer) { log.warn(...); await unlink(pidfilePath); process.exit(0); }
5. const { handleSignal } = setupShutdown(
       mcpServer, pool, process.exit,
       async () => { try { await unlink(pidfilePath); } catch {} });
6. process.on("SIGTERM", () => { clearInterval(reaper); void handleSignal("SIGTERM"); });
   process.on("SIGINT",  () => { clearInterval(reaper); void handleSignal("SIGINT"); });
   process.stdin.on("end", () => { clearInterval(reaper); void handleSignal("stdin-eof"); });
   process.on("exit",     () => { try { unlinkSync(pidfilePath); } catch {} });
       // SYNC-ONLY — Node drops async listeners on 'exit'
7. await mcpServer.connect(new StdioServerTransport());
```

Note step 4: even with a duplicate detected, we unlink **our own**
`pidfilePath` (the local variable from step 3) before exit. The
pre-existing peer's pidfile is identified by a different UUID and
must not be touched.

**Admin tool** (`scripts/supervisor-clean.ts` + skill wrapper):
walks `$RUN_DIR/supervisor.*.pid`, cross-references with `ps`,
categorizes each entry as `live-peer` / `orphan` / `stale`, prints
a table with distinct visual treatment per category, and:

- Default mode: SIGTERM `orphan` (after confirmation), unlink `stale`.
- `--force`: also offers `live-peer` for SIGTERM with a separate
  per-entry warning naming the live `claude_pid` parent.
- Never auto-kills without confirmation.

### Existing Infrastructure Audit

| Proposed Component | Existing Module | Decision |
| --- | --- | --- |
| `src/lifecycle.ts` (pidfile + sweep) | (none) | New — no overlap |
| `src/shutdown.ts` extensions (pidfile-remove + stdin-end + exit handlers) | `src/shutdown.ts:36-103` (`setupShutdown` — SIGTERM/SIGINT, idempotent via `shutdownStarted`, drains SessionPool with 5s/session timeout) | **Extend**: add `onShutdown` callback parameter for pidfile-remove; wire `stdin.end` + `exit` in `server.ts` alongside existing SIGTERM/SIGINT |
| `~/.qwen-coprocessor-stack/run/` | `~/.qwen-coprocessor-stack/config.json` | Reuse parent dir; new subdir |
| `/qwen-stack:supervisor-clean` skill | `/qwen-stack:status` skill (read-only listings) | Extend pattern (read+act with confirmation) |

### Decision Rationale

The nexus precedent is direct: structurally identical problem (MCP
child process lifecycle coupled to a Claude Code parent), validated
solution shape (layered cleanup), validated failure modes (single-hook
shutdown loses on SIGKILL, ppid-keyed identity breaks under owned
subprocess modes).

Adopting the model wholesale — rather than picking one layer at a
time — avoids the "we'll add more layers when it breaks again" trap.
The cost is small (three files, one skill, one config dir). The
benefit is self-healing across reload and ungraceful-exit scenarios
without any manual `pkill`.

## Alternatives Considered

### Alternative 1: Pidfile-only (RDR-original Option B)

**Description**: Write a pidfile keyed by `claude_ppid`; refuse to
start a duplicate. No startup sweep, no admin tool.

**Pros**: Smallest change. Catches the `/reload-plugins` leak.

**Cons**: Does nothing for the cross-session stale pile. Does nothing
for wedged supervisors. Pidfiles themselves can become stale and
prevent legitimate startups after an ungraceful exit.

**Reason for rejection**: nexus already learned that pidfiles without
a sweep produce the inverse failure mode — false-positive duplicates
blocking real startups.

### Alternative 2: Admin-tool-only (RDR-original Option A)

**Description**: `/qwen-stack:supervisor-clean` skill that lists and
kills stale supervisors. No pidfile, no startup sweep, no shutdown
chain change.

**Pros**: Smallest user-visible surface; manual control.

**Cons**: Requires human in the loop. Does not address root cause.
The user must know to run it when the pile grows.

**Reason for rejection**: Manual tools that *should* be automatic are
forgotten until they hurt.

### Alternative 3: PPID-walk session identity

**Description**: Identify "session" by walking ppid chain to topmost
`claude*` ancestor. Use that as the key for everything.

**Pros**: No extra state files.

**Cons**: Nexus RDR-105 RF-6 documents this *silently* breaks under
owned-subprocess scenarios (e.g., `claude -p` spawning a subordinate
claude). Topmost-walk is worse than first-match. Either way, identity
≠ ppid.

**Reason for rejection**: Documented prior failure in nexus; we'd
inherit the same silent-break.

### Briefly Rejected

- **SessionStart-hook-only cleanup**: would kill other live sessions'
  supervisors. Wrong scope.
- **Reboot-only "fix"**: leaves the bug present.
- **Stdio heartbeat as MVP layer**: defer to a follow-up. Detecting
  wedged-but-alive is materially harder than the other three layers
  and shouldn't gate them.

## Trade-offs

### Consequences

- **(+)** Self-healing across `/reload-plugins` cycles and ungraceful
  Claude exits — no manual `pkill` required.
- **(+)** Admin tool gives operator-visible state when things do go
  wrong (Gap 3 wedge case).
- **(+)** Pattern matches nexus precedent — operator's mental model
  transfers between projects.
- **(−)** New state directory (`~/.qwen-coprocessor-stack/run/`) and
  stale-pidfile failure mode to reason about.
- **(−)** Adds a small amount of startup latency (sweep + write).
- **(−)** Pidfile sweep needs `ps` shell-outs (or `/proc` on Linux);
  cross-platform code surface.

### Risks and Mitigations

- **Risk**: Pidfile sweep accidentally kills a legitimate supervisor
  during a Claude reconnect race.
  **Mitigation**: Sweep only *removes the file*; it only SIGTERMs
  truly-orphaned supervisors (parent dead, child alive, `comm`
  matches). Live parent → leave alone.
- **Risk**: Stale pidfile from an OOM'd supervisor blocks new
  startup. **No longer possible** — UUID-keyed filenames mean no
  two processes ever target the same path. `refuseDuplicate` is a
  post-write peer check; sweep handles stale-file removal.
- **Risk**: `process.on('exit')` async-listener footgun.
  **Mitigation**: Documented in design; `exit` handler is a
  literal `unlinkSync` call only, never `async`. Async cleanup
  runs in SIGTERM/SIGINT/stdin-end handlers via `setupShutdown`.
- **Risk**: Forced-kill path (`exit(1)` after pool-drain timeout
  in existing `shutdown.ts:93`) bypasses async pidfile-removal.
  **Mitigation**: `onShutdown` callback runs **before** pool drain,
  not after, so pidfile is removed even if pool drain forces exit(1).
  Sync `exit` handler is a backstop, not the primary path.
- **Risk**: NFS-mounted `$HOME` gives inconsistent `kill(pid,0)`
  semantics; container PID-namespace resets cause pid-reuse.
  **Mitigation**: Prefer `$XDG_RUNTIME_DIR` (tmpfs, per-session,
  systemd-cleaned). `comm` check in sweep + refuse-duplicate detects
  pid-reuse across container restarts.
- **Risk**: BSD vs. GNU `ps` divergence breaks Linux dev hosts.
  **Mitigation**: Linux path uses `/proc/<pid>/comm` directly; macOS
  uses `ps -o comm= -p <pid>`. One thin abstraction in `commOf()`.
- **Risk**: `claude -p` nesting (outer Claude spawning inner Claude
  spawning a second MCP supervisor child) — both legitimate children
  share `process.ppid` for some ancestor.
  **Mitigation**: UUID-keyed pidfiles eliminate file collision.
  `findLivePeer` matches on `claude_ppid` AND `comm`, AND only
  refuses when peer is truly alive — but since each `claude -p` instance
  is itself the immediate parent of its own MCP child, the `ppid`
  values for inner vs. outer supervisors differ. The refuse-duplicate
  fires only on true duplicates (two MCP children of the same
  immediate `claude` process), which is the desired behavior.

### Failure Modes

- **Visible failure**: Duplicate-startup refused → supervisor exits
  with a clear log line; parent Claude session sees MCP child died,
  re-spawns (which then succeeds because the duplicate cleared).
- **Visible failure**: Sweep deletes pidfile of a supervisor whose
  parent died seconds ago — supervisor will SIGTERM-on-stdin-EOF
  shortly anyway; sweep just hurries the bookkeeping.
- **Silent failure (acknowledged)**: Wedged supervisor with live
  parent and live stdio FD but blocked event loop — Gap 3, deferred
  to follow-up. Operator workaround: `/qwen-stack:supervisor-clean`.
- **Diagnosis path**: `ls ~/.qwen-coprocessor-stack/run/` + `ps`
  cross-check shows current state in two commands.

## Implementation Plan

### Prerequisites

- [ ] A1 spike bead `qwen-coprocessor-stack-huy` complete before
      Phase 1 Step 4 (server.ts wiring) — drives Gap 1 framing.
- [x] A2 verified 2026-05-20 (Source Search) — see T2
      `005-research-01-a2-source-audit`.
- [x] A4 explicitly deferred from MVP (wedge-detection heartbeat
      becomes follow-up RDR after MVV ships).

### Minimum Viable Validation

Two scenarios, **both equally gating** — neither may be deferred:

**MVV-1 (sweep):** kill -9 a supervisor; start a new Claude session;
observe (a) startup sweep removes the dead supervisor's pidfile, (b)
new supervisor starts cleanly with its own UUID-keyed pidfile, (c)
no duplicate-refuse fires.

**MVV-2 (idempotent shutdown under race):** in an integration test,
send SIGTERM and close stdin to a running supervisor within a 10ms
window; assert that (a) `cleanup`/`onShutdown` runs **exactly once**
(observable via log line count and pidfile-unlink count), (b) the
pidfile is removed regardless of whether the SIGTERM async path or
the stdin-end async path or the sync `exit` fallback won the race,
(c) exit code is 0 (or 1 if pool drain timed out — still acceptable,
pidfile must still be gone).

MVV-2 is the actual regression magnet — single-hook shutdown losing
on concurrent signal+EOF is what nexus RDR-094 was written to fix.
Promoting it to MVV ensures we don't ship a sweep-only solution and
discover the race in production.

### Phase 1: Code Implementation

#### Step 1: Spike A1 + audit (A2)

Reproduce or rule out `/reload-plugins` double-spawn. Document current
shutdown path in supervisor. Outputs: spike notes in bead description;
RDR updated if findings shift design.

#### Step 2: `src/lifecycle.ts` + tests

Implement pidfile + sweep + duplicate-check. Tests use tmp run-dir
fixture; fake `ps` cmd for portability tests.

#### Step 3: `src/shutdown.ts` + tests

Implement idempotent cleanup chain wired to signals + stdin-end +
exit. Tests assert single-execution under concurrent signals.

#### Step 4: Wire into `server.js` startup

Sweep → refuse-or-write pidfile → install handlers → boot MCP. Update
existing entry point.

### Phase 2: Operational Activation

#### Activation Step 1: `/qwen-stack:supervisor-clean` skill

Skill markdown + `scripts/supervisor-clean.ts`. Interactive list+kill.
No auto-mode for v0.

#### Activation Step 2: Document in plugin README

Brief note in plugin docs about the run-dir and the skill.

### Day 2 Operations

| Resource | List | Info | Delete | Verify | Backup |
| --- | --- | --- | --- | --- | --- |
| `$RUN_DIR/supervisor.*.pid` | `ls $RUN_DIR` | `cat <file>` | `rm <file>` (safe; auto-recreated) | sweep on next startup; `/qwen-stack:supervisor-clean` | N/A — ephemeral; `$RUN_DIR = $XDG_RUNTIME_DIR/qwen-coprocessor-stack` or `$HOME/.qwen-coprocessor-stack/run` |
| `/qwen-stack:supervisor-clean` skill output | skill itself | skill itself | skill itself | `ps` cross-check | N/A |

Backup is N/A — pidfiles are derived state.

### New Dependencies

None. Uses Node stdlib (`fs`, `child_process` for `ps` shell-outs,
`process`) only.

## Test Plan

- **Scenario**: Fresh boot, no prior pidfiles — **Verify**: Pidfile
  written for our claude_ppid; supervisor serves MCP normally.
- **Scenario**: Boot with stale pidfile (dead claude_ppid in body) —
  **Verify**: Sweep removes it; new UUID-keyed pidfile written; no
  duplicate refuse.
- **Scenario**: Boot with live peer (existing pidfile, live
  supervisor pid, matching `comm`, same `claude_ppid`) —
  **Verify**: New supervisor exits 0 with "duplicate-for-parent" log;
  own pidfile cleaned up before exit.
- **Scenario**: Boot with pidfile pointing to live-but-unrelated pid
  (pid reuse) — **Verify**: `comm` mismatch in sweep → file removed;
  new pidfile written; no false-positive refuse.
- **Scenario**: SIGTERM during MCP request — **Verify**: `onShutdown`
  unlinks pidfile **before** pool drain; `cleanup` runs once; exit 0.
- **Scenario (MVV-2)**: SIGTERM + stdin-EOF arrive within 10ms —
  **Verify**: `handleSignal` runs exactly once (asserted via log
  count); pidfile removed exactly once; exit 0 or 1 acceptable.
- **Scenario**: SIGTERM with pool drain timing out (forced exit 1) —
  **Verify**: Pidfile already removed by `onShutdown` before timeout
  fires; `exit(1)` does not leave a stale file.
- **Scenario**: SIGKILL — **Verify**: Pidfile remains; sync `exit`
  handler does not run (SIGKILL is uncatchable); next startup sweep
  reaps it.
- **Scenario**: `claude -p` nested invocation — **Verify**: Inner
  Claude's MCP supervisor starts cleanly (its `process.ppid` is the
  inner claude pid, not the outer); no false-duplicate refuse.
- **Scenario**: `$XDG_RUNTIME_DIR` set vs. unset —
  **Verify**: Run dir resolves to XDG path when set, HOME path
  otherwise; pidfiles work in both locations.
- **Scenario**: `/qwen-stack:supervisor-clean` with mixed orphan +
  live-peer + stale — **Verify**: Each categorized correctly;
  default mode SIGTERMs only orphan, unlinks only stale; live-peer
  display-only without `--force`.
- **Scenario**: macOS vs. Linux `commOf()` — **Verify**: `/proc`
  path on Linux, `ps` path on macOS report identical results for the
  same process tree.

## Validation

### Testing Strategy

Unit tests for each module (`lifecycle.ts`, `shutdown.ts`) with
fake-clock + tmp-dir fixtures. Integration tests spawn real
supervisors and assert pidfile state transitions.

1. **Scenario**: Concurrent SIGTERM + stdin-EOF
   **Expected**: One cleanup invocation; one log line; idempotent.
2. **Scenario**: Sweep of 10 stale pidfiles
   **Expected**: All removed in <100ms.
3. **Scenario**: Cross-platform `ps` parity
   **Expected**: Same supervisor set reported on macOS and Linux.

### Performance Expectations

Startup overhead target: <50ms for sweep + pidfile write on a host
with 10 stale files. Empirical only — measure during impl.

## Finalization Gate

> Complete each item with a written response before
> marking this RDR as **Accepted**.

### Contradiction Check

To be completed at gate. Open question: whether Gap 3 (wedge
detection) should remain deferred or be folded into MVP — depends on
A4 spike outcome.

### Assumption Verification

A3 is acceptable as Docs-Only (standard POSIX). A1, A2, A4 must be
spike/source-search verified before implementation. Track via
prerequisite checklist above.

#### API Verification

| API Call | Library | Verification |
| --- | --- | --- |
| `process.kill(pid, 0)` | Node stdlib | Docs Only (POSIX standard) |
| `process.on('SIGTERM'|'SIGINT'|'exit')` | Node stdlib | Source Search at impl |
| `process.stdin.on('end')` | Node stdlib | Docs Only |
| `fs.promises.open(path, 'wx')` (O_EXCL) | Node stdlib | Docs Only — Node docs explicit on `'wx'` flag |
| `fs.{unlinkSync, promises.unlink, promises.readdir}` | Node stdlib | Docs Only |
| `crypto.randomUUID()` | Node stdlib | Docs Only (Node 14.17+) |
| `ps -o comm= -p <pid>` | macOS BSD ps | Spike at impl |
| `/proc/<pid>/comm` | Linux procfs | Docs Only |
| `process.env.XDG_RUNTIME_DIR` | systemd convention | Docs Only |

### Scope Verification

Both MVV scenarios are in scope and gating: MVV-1 (sweep) and MVV-2
(concurrent SIGTERM+stdin-EOF idempotence) are Phase 1 Step 4
acceptance criteria. Neither deferred.

### Cross-Cutting Concerns

- **Versioning**: Pidfile format is internal; bump only matters if
  it changes between supervisor versions during a single session,
  which doesn't happen. N/A.
- **Build tool compatibility**: TypeScript build unchanged; new
  files compile under existing tsconfig.
- **Licensing**: AGPL-3.0-or-later per repo LICENSE.
- **Deployment model**: Local-only (per-host run-dir under
  `$HOME`). No shared infrastructure.
- **IDE compatibility**: N/A.
- **Incremental adoption**: Each layer (sweep, pidfile, shutdown
  chain, admin tool) ships independently behind sequential beads;
  rollback is per-layer.
- **Secret/credential lifecycle**: N/A — pidfile contains pid +
  timestamp only.
- **Memory management**: N/A — startup-time bounded work.

### Proportionality

Right-sized. Four small layers; ~300 LoC + tests; one skill.
Significantly smaller than nexus's equivalent because we don't have
a multiprocessing-resource-tracker problem and don't own a chroma
subprocess.

## References

- nexus RDR-105 (T1 discovery + addr files): `src/nexus/session.py:768-792`,
  `src/nexus/mcp/core.py:179-210`, `tests/test_t1_discovery.py:208-249`
- nexus RDR-094 (session lifecycle + multi-path shutdown):
  `src/nexus/mcp/core.py:305-338`, `tests/test_plugin_structure.py:501-527`,
  `scripts/spikes/spike_rdr094_lifecycle.py`
- nexus session identity rationale: `src/nexus/session.py:586-620`
  (UUID-keyed sessions, not ppid-keyed)
- Node docs: `process` events (SIGTERM, SIGINT, exit, stdin end)
- POSIX `kill(2)` — signal 0 for liveness probe

## Revision History

### 2026-05-20 — Gate run 1: BLOCKED

substantive-critic findings — 2 critical, 2 significant, 3 observations.
Full record in T2 `005-gate-latest`. Summary:

**Critical (must fix before re-gate):**

- **C1: TOCTOU between `refuseDuplicate` and `writePidfile`.** Read-then-write
  sequence leaves a race window where two `/reload-plugins` supervisors both
  pass the duplicate check and both write. Nexus closed the equivalent race
  with `O_CREAT|O_EXCL`. Fix: single `fs.promises.open(path, 'wx')`
  exclusive create; on `EEXIST`, read existing to decide live-or-stale.
- **C2: `process.ppid` as pidfile key inherits RF-6 silent-break under
  `claude -p` nesting.** Outer + inner Claude share the same ppid for their
  legitimate MCP children, so the inner is refused as a duplicate. Nexus
  uses UUID-keyed sessions with ppid only as a *discovery hint*. Fix: key
  the pidfile content on a generated UUID; use ppid only to *find candidate
  files* during sweep; refuse duplicate only when ppid + live supervisor
  pid + cmd all match.

**Significant:**

- **S1: `$HOME` run-dir vs. `$XDG_RUNTIME_DIR`.** NFS-mounted `$HOME` gives
  inconsistent `kill(pid,0)` semantics; container restarts produce
  false-positive liveness via PID reuse. Prefer `$XDG_RUNTIME_DIR` when
  set, fall back to `$HOME/.qwen-coprocessor-stack/run/`.
- **S2: MVV proves sweep but skips the actual regression magnet.** Promote
  the concurrent-SIGTERM+stdin-EOF idempotence scenario to MVV; current
  MVV (kill -9 + new session) becomes scenario 1, idempotence becomes
  equally-gating scenario 2.

**Observations (fold into impl):**

- O1: `process.on('exit')` is sync-only — async listeners silently drop
  their promise. The Design snippet shows `cleanup` as async; the `exit`
  handler must be a sync `unlinkSync` wrapper only.
- O2: `setupShutdown`'s forced-kill `exit(1)` (`shutdown.ts:93`) fires
  before any async pidfile-removal completes. Trace this path in the
  implementation; don't rely on `exit` handler as a pidfile fallback.
- O3: Admin skill must visually distinguish live-peer (parent alive,
  supervisor alive, both legitimate) from orphan (parent dead). Never
  offer to kill the former without a warning.

**Disposition:** revise Proposed Solution §Pidfile contract +
§"Order of operations" + §MVV; re-run gate. A1 spike bead
`qwen-coprocessor-stack-huy` unchanged.

### 2026-05-20 — Revision for gate run 2

Addressed all findings from gate run 1:

- **C1 (TOCTOU)**: Filename now UUID-keyed (`supervisor.<uuid>.pid`),
  created with `fs.promises.open(path, 'wx')` (`O_EXCL`). Filename
  collisions are impossible by construction. Refuse-duplicate is now
  a *post-write peer check* over sibling pidfiles, not a write-time
  race. See §Pidfile contract + §Startup wiring step 3.
- **C2 (ppid as key)**: ppid moved from filename to body. Identity
  is the UUID. `findLivePeer` uses ppid as a discovery hint plus `comm`
  match plus pid-liveness. `claude -p` nested invocations work because
  inner and outer Claudes have different pids → different `ppid` values
  for their respective MCP children. See §Approach identity rule and
  §Risks "`claude -p` nesting".
- **S1 (`$HOME` vs. `$XDG_RUNTIME_DIR`)**: Added `resolveRunDir()`
  preferring `$XDG_RUNTIME_DIR/qwen-coprocessor-stack/` when set,
  falling back to `$HOME/.qwen-coprocessor-stack/run/`. Documented
  NFS/container caveats. See §Run directory selection.
- **S2 (MVV theatrical)**: Split MVV into two equally-gating scenarios:
  MVV-1 (sweep after kill -9) and MVV-2 (concurrent SIGTERM+stdin-EOF
  idempotence). See §Minimum Viable Validation.
- **O1 (`process.on('exit')` async footgun)**: §Startup wiring step 6
  shows `exit` handler as `unlinkSync` only with an inline comment
  flagging the Node async-listener-drop behavior.
- **O2 (forced-exit bypass)**: `onShutdown` callback parameter added
  to `setupShutdown`; invoked **before** pool drain so pidfile is
  removed even when drain times out and forces `exit(1)`. See
  §Shutdown chain extension. New risk row covers this explicitly.
- **O3 (admin tool live-peer visibility)**: Three-category
  categorization (`live-peer` / `orphan` / `stale`) with distinct
  visual treatment and a `--force` gate for killing live peers.
  See §Admin tool (Approach item 4) and §Admin escape hatch.

### 2026-05-20 — Gate run 2: PASSED

substantive-critic: 0 critical, 0 significant, 2 observations
(implementation-level). All gate-1 findings closed. T2 record:
`005-gate-latest`. Observations folded into design:

- **O4**: §Startup wiring step 4 commentary clarified — unlink targets
  the local `pidfilePath` from step 3, never any peer-derived path.
- **O5**: `writePidfileExclusive` API sketch annotated — body includes
  own `comm`. `sweepStalePidfiles` and `findLivePeer` both depend on
  parsing it back; ensure body-write/body-parse symmetry at impl.

Ready for `/nx:rdr-accept 005`.
