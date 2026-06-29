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

**Draft — research COMPLETE, gate-ready (2026-06-29).** Findings 1–3 (all
measured) settle the design: agent-lsp already provides warm reuse + a ~30 min
idle self-reap (so no ops-side idle reaper — refutes the original accumulation
premise), but the Java-burst peak is material (~1.7 GB/jdtls, Finding 3), so a
single, bounded piece of work remains: a **jdtls-weighted resident-broker cap**
(LRU `daemon-stop`) in the keepalive, plus docs. Ready for `/conexus:rdr-gate`.

Follow-up to RDR-014 (closed, shipped v0.11.13) and its
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

**Settled by Findings 1–3 (all measured).** agent-lsp already ships *both* halves
of the lifecycle we were worried about: a persistent per-(root,language)
**daemon-broker** for warm cross-spawn reuse (survives our teardown), **and** a
~30 min idle self-reap that bounds resident brokers. So the warm-reuse benefit is
available **today with zero supervisor change**, and the feared *steady-state*
"unbounded accumulation" does not occur. The one residual risk — *peak*
simultaneous Java brokers within the 30 min window — was measured and is real
(~1.7 GB/jdtls, Finding 3). The RDR therefore lands as **document + rely on
agent-lsp's lifecycle, plus one bounded mitigation**: a jdtls-weighted
resident-broker cap in the keepalive.

### In scope (proposed — to be locked at gate)

1. **Adopt + document the daemon-broker** as the warm-reuse substrate: rely on
   it; keep teardown as-is (do NOT kill brokers — that defeats reuse); state the
   ~30 min idle self-reap so operators know resident brokers are self-bounding.
2. **Resident-broker cap (jdtls-driven) — measured YES (Finding 3).** Add a
   resident-broker cap that evicts the **oldest-started** broker via `agent-lsp
   daemon-stop` once a limit is exceeded, hosted in the **Mac** keepalive
   LaunchAgent (the agent-lsp registry `~/.cache/agent-lsp/daemons/` lives on the
   host running the `qwen-code` CLI — the Mac/Claude-Code host — *not* the box;
   the box keepalive manages llama-server only and has no agent-lsp brokers).
   Eviction is **FIFO by `start_time`, not true LRU** — `daemon.json`'s
   `last_activity` is not updated per tool-use (Finding 1, verified), so a true
   LRU key is not available from the registry; an actively-used oldest broker may
   be evicted and simply re-warm on its next `start_lsp` (acceptable). Because
   the footprint is dominated by jdtls (~1.7 GB floor) and TS/Go are trivial
   (~88 MB), the cap should be **weighted/limited by Java brokers** (or a small
   total like ~3–4) rather than a flat count that would needlessly evict cheap
   tsserver brokers. The limit is **mandatory per-host tuning** against the true
   post-indexing jdtls peak (Finding 3), not a shipped constant. Steady-state
   idle reaping stays agent-lsp's job (~30 min); the cap only bounds the *peak
   within* that window.
3. **Docs** — USER_GUIDE: warm-reuse is automatic + the `.agent-lsp/cache.db.gz`
   recipe; ARCHITECTURE: broker ownership + the unchanged teardown bright line.

### Out of scope (proposed)

- An ops-side **idle reaper** — **dropped.** agent-lsp self-reaps at ~30 min
  (Finding 1); building our own idle sweeper would duplicate it.
- Building our own agent-lsp pool / shared HTTP service — agent-lsp's daemon
  already is one (YAGNI; same posture as RDR-014).
- Pre-warming every repo at boot — pre-warm only an explicit hot-repo list, if
  at all (deferred unless research shows first-cold dominates).
- Committing `.agent-lsp/cache.db.gz` into target repos — a per-repo operator
  decision, noted as a recipe only.

### Bright line (proposed)

The supervisor's teardown contract is **unchanged**: it still does not touch the
agent-lsp process tree (RDR-013). Broker lifecycle is owned by agent-lsp (warm
reuse + ~30 min idle self-reap) plus an **ops-side broker cap** (keepalive-hosted
jdtls-weighted eviction) — never by the per-session abort path.

### Approach (proposed — numbered for phase-review cross-walk)

1. Verify broker survival + reaping mechanics against the live tool — **DONE**
   (Findings 1–2: survival confirmed; ~30 min idle self-reap measured; tsserver
   footprint ~88 MB/root; jdtls is the only JVM caveat).
2. Java-burst peak measured (~1.7 GB/jdtls, Finding 3) — **cap warranted**.
   Implement a jdtls-weighted LRU resident-broker cap via `daemon-stop` in the
   keepalive, with per-host limits (box vs Mac).
3. Optionally set `AGENT_LSP_BROKER_TIMEOUT_MS` in `applyCodeIntel`'s agent-lsp
   `env` (start-timeout headroom for large cold repos — NOT an idle knob).
4. Optionally pin an installed `agent-lsp` over `uvx agent-lsp` to drop the
   per-spawn resolve; weigh against the RDR-014 "prereq not installed by us".
5. Docs: USER_GUIDE warm-reuse + cache recipe; ARCHITECTURE broker-ownership +
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
- **Automatic idle self-reap at ~30 min — MEASURED (single observation,
  v0.15.x; supersedes the original "no idle reaping / leak confirmed" claim,
  which was wrong).** A fresh broker, with **no client connected**, was polled
  every 60 s: it stayed alive through t+29m and was **gone at t+30m** (idle-watch
  log, 2026-06-28). agent-lsp self-terminates idle brokers (and cascade-stops
  their LSP child) after ~30 min. *Caveats:* n=1, 60 s poll resolution (true TTL
  is somewhere in 29–30 min), and the behavior is **agent-lsp-version-dependent
  and not contractual** — re-verify on agent-lsp upgrade. Non-Java brokers
  (tsserver ~88 MB) have **no fallback** if a future version changes this; at
  that footprint the practical risk is low (50 TS roots ≈ 4.4 GB), but a periodic
  `agent-lsp daemon-list` audit in the keepalive is a cheap tripwire if desired.
  The earlier "orphaned typescript-language-server up to 4d10h" leak evidence was
  **retracted** — those processes are children of `claude` (Serena/Claude Code's
  own LSP integration), not agent-lsp brokers (verified `ps -o ppid`). So the
  **"unbounded accumulation" premise is refuted**: resident brokers are bounded
  by the set of roots/languages touched within the trailing 30 min, not by
  cumulative spawn count.
- **Idle TTL is not env-tunable.** `AGENT_LSP_BROKER_TIMEOUT_MS` is the broker
  *start* timeout (`brokerStartTimeout`), not the idle TTL; no idle-TTL env var
  exists (env surface: `AGENT_LSP_BROKER_TIMEOUT_MS`, `AGENT_LSP_AUDIT_LOG`,
  `AGENT_LSP_OUTPUT_FORMAT`, `AGENT_LSP_TOKEN`). The ~30 min idle reap appears
  hardcoded. A manual reap also exists (`agent-lsp daemon-stop --root-dir=X
  --language=Y`; `StopDaemon`/`stop_daemon_unix.go`) for forced eviction.
- **`daemon.json` `last_activity` is NOT a per-tool-use timestamp — VERIFIED
  2026-06-29.** Two tool calls 8 s apart left `last_activity` unchanged (fixed at
  the start/ready value). So the internal idle reap tracks live connection state
  in-memory, not this field, and an external eviction policy that reads the
  registry can only sort by **start-time (FIFO), not true LRU**. This bounds the
  cap design (see In-scope item 2): FIFO-by-oldest-start, accepting that a
  long-lived but actively-used broker could be evicted and simply re-warm on its
  next `start_lsp`. (Granularity may differ across versions; re-verify if a true
  LRU signal is ever needed.)

### Finding 2 — footprint is small for tsserver; only peak concurrency could matter (MEASURED 2026-06-28)

- **Per-broker RSS** (warm, idle): the `agent-lsp daemon-broker` process ~22 MB
  + its `typescript-language-server` child ~66 MB ≈ **~88 MB per (root, ts)**.
  Negligible against the box (~32 GB system) / Mac (128 GB) budgets at any
  realistic root count.
- **The JVM caveat is jdtls.** Java roots spawn `jdtls` (a full Eclipse JDT
  JVM, typically 300 MB–1 GB+ resident), so a burst of distinct *Java* roots
  within the 30 min window is the only plausible footprint concern — not TS/Go.
- ⇒ Steady-state leak is a non-issue (self-reap handles it). The residual risk
  is **peak** simultaneous Java brokers under bursty first-class use; a thin
  resident-broker cap is the only candidate mitigation, and only if a measured
  Java-heavy burst shows it.

### Finding 3 — Java burst peak is material: ~1.7 GB per jdtls (MEASURED 2026-06-29)

Drove 3 distinct Java roots (`java-uuid-generator`, `evrete`, `jbizur`)
concurrently through agent-lsp (`start_lsp(java, ready_timeout=60)`), sampling
total `jdtls` RSS every 5 s for 60 s:

- **Peak total ≈ 5.1 GB across 3 roots ⇒ ~1.7 GB per jdtls** (stable through the
  measured 60 s window; 3 processes). ~20× the tsserver footprint (~88 MB/root).
  *This figure is a FLOOR, not a calibrated midpoint:* jdtls indexes
  asynchronously **after** the LSP `initialized` handshake that `start_lsp`
  waits on, so background compilation/classpath RSS can keep climbing past 60 s.
  The three test repos (`java-uuid-generator`, `evrete`, `jbizur`) are small
  libraries; enterprise Java repos will peak materially higher. A longer sample
  (2–5 min, or until a build-complete signal) would calibrate it — deferred to
  implementation, since the cap decision is insensitive to a 2× error here.
- Extrapolation (linear, lower-bound): 6 concurrent Java roots ≳ ~10 GB, held up
  to the 30 min idle window. On the box (~32 GB system carveout) and the Mac
  (128 GB unified, but the served model already takes ~42 GB+ and MLX runs
  `-w1`), an unbounded Java burst can contend with the model's RAM.
- `agent-lsp daemon-stop --root-dir=… --language=java` reaped all three cleanly
  (0 jdtls, 0 registry entries) — confirms the eviction lever for a cap works.

⇒ **Decision item 2 resolves YES: a resident-broker cap is warranted**, driven
entirely by jdtls. tsserver/gopls bursts remain a non-issue. The cap limit must
be **tuned per host against the true (post-indexing) jdtls peak**, treating
1.7 GB as a floor — not shipped as a fixed constant.
- **Persistent symbol cache** exists separately at `~/.agent-lsp/cache/`
  (committable as `.agent-lsp/cache.db.gz` — "teammates skip cold-start
  indexing"); amortizes cold-start across daemon restarts/machines.

Repro: drive agent-lsp over an MCP stdio client (`@modelcontextprotocol/sdk`),
inspect `~/.cache/agent-lsp/daemons/*/daemon.json` and `ps -o pid,etime,rss`.
bd memory: `codeintel-agentlsp-daemon-lifecycle-2026-06-28`,
`codeintel-roughedge-rootcause-2026-06-28`.

## Consequences

### Positive

- Warm cross-spawn `start_lsp` reuse **and** idle reaping are **both already
  provided** by agent-lsp (measured) — first-class use pays per-root indexing
  once, resident brokers self-bound at ~30 min idle, and the supervisor needs
  **no change** (the only build is an ops-side cap, not core/supervisor code).

### Negative

- Peak Java-burst footprint is **confirmed material** (Finding 3): ~1.7 GB per
  jdtls, held up to 30 min. The mitigation (jdtls-weighted resident cap via
  `daemon-stop` in the keepalive) is now in scope — a real, if small, ops
  surface to build and tune per host.
- The ~30 min idle TTL is **not env-tunable** (Finding 1) — the cap (manual
  `daemon-stop`) is therefore the *only* lever for bounding peak; we can't just
  shorten the TTL on the box.

### Neutral

- The supervisor stays out of broker lifecycle entirely (RDR-013 bright line
  intact); all lifecycle logic lives in agent-lsp + the keepalive.
- codeIntel posture stays opt-in until the resident cap ships; first-class use
  on Java-heavy hosts is gated on that cap (Finding 3). TS/Go-only use is
  already safe today (warm reuse + 30 min self-reap, trivial footprint).
