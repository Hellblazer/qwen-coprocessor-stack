---
title: "codeIntel agent-lsp daemon lifecycle — document TS/Go daemon-broker warm reuse and the in-process jdtls model; defer any spawn-concurrency cap"
id: RDR-015
type: Design
status: closed
closed_date: 2026-09-20
priority: medium
author: hal
reviewed-by: self
created: 2026-06-28
reopened_date: 2026-07-01
accepted_date: 2026-07-02
related_issues: []
---

# RDR-015: codeIntel agent-lsp daemon lifecycle

> Revise during planning; lock at implementation.
> If wrong, abandon code and iterate the RDR.

## Status

**Re-opened 2026-07-01 after a BLOCKED re-gate (supersedes the 2026-06-29
accept).** A re-verification (Finding 4 — four probes on the same agent-lsp
0.15.0 / jdtls 1.57.0, driven exactly as `applyCodeIntel` launches it) refuted
the load-bearing premise: **jdtls does *not* use the daemon-broker.** It runs
**in-process** under each spawn's `uvx agent-lsp`, as a **single shared instance
across that spawn's Java roots**, and **dies at teardown** — it is never
registered in `~/.cache/agent-lsp/daemons/`. The daemon-broker survival + ~30 min
idle self-reap that Findings 1–2 measured are a **TypeScript/Go** property; they
do **not** generalize to jdtls (the only language with material RAM, and the
entire justification for the original cap). Consequences:

- **Decision item 1 (warm cross-spawn reuse) is scoped to TS/Go.** jdtls pays a
  full cold `start_lsp` index on **every** spawn; the cold-start amortizer for
  jdtls is the persistent symbol cache (`.agent-lsp/cache.db.gz`), not broker
  reuse.
- **Decision item 2's registry `daemon-stop` FIFO cap is retracted** — it is a
  structural no-op for jdtls (the registry it reads is always empty for Java).
  Finding 3's "eviction lever works" did not reproduce. The real Java RAM concern
  is **concurrent in-process jdtls across overlapping codeIntel spawns**
  (~0.8–2 GB each, alive only for the spawn), which is **bounded and
  self-cleaning** (no accumulation) — a *spawn-concurrency* concern, not a
  resident-registry one. This RDR now **documents** it and **defers** any
  spawn-concurrency cap to a future supervisor-side design, gated on measured
  need (see In-scope item 2).

The RDR therefore lands as **document the real lifecycle (TS/Go warm reuse;
jdtls cold-per-spawn but self-cleaning) + no code build this cycle**.
**Re-gate PASSED and re-accepted 2026-07-02** (0 critical; substantive-critic's
2 significant folded in).

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

**Settled by Findings 1–4 (all measured), with jdtls behaving differently from
TS/Go (Finding 4).** For **TypeScript/Go**, agent-lsp ships a persistent
per-(root,language) **daemon-broker** for warm cross-spawn reuse (survives our
teardown) plus a ~30 min idle self-reap that bounds resident brokers — the
warm-reuse benefit is available today with zero supervisor change, and
steady-state accumulation does not occur. For **jdtls**, none of that applies:
jdtls runs **in-process** per spawn, one shared instance across that spawn's Java
roots, and is reaped at teardown (Finding 4). So there is **no cross-spawn warm
reuse for jdtls** and **no resident jdtls to cap** — the only Java footprint is
the *concurrent* in-process jdtls set during overlapping spawns (~0.8–2 GB each,
Findings 3–4), which is bounded and self-cleaning. The RDR therefore lands as
**document the real lifecycle** and **defer** any spawn-concurrency mitigation to
a future supervisor-side design gated on measured need — **no code build this
cycle**.

### In scope (proposed — to be locked at gate)

1. **Document the daemon-broker as the TS/Go warm-reuse substrate** (Findings
   1–2): rely on it for TypeScript/Go; keep teardown as-is (do NOT kill brokers —
   that defeats reuse); state the ~30 min idle self-reap so operators know
   resident **TS/Go** brokers are self-bounding. **Explicitly scope this to
   TS/Go**: jdtls does not use the broker (Finding 4), so there is no jdtls warm
   reuse — each jdtls-bearing spawn pays a cold `start_lsp` index. The jdtls
   cold-start amortizer is the persistent symbol cache (`.agent-lsp/cache.db.gz`,
   Finding 3), not broker reuse.
2. **jdtls concurrency footprint — documented, mitigation DEFERRED.** Finding 4
   retracts the original registry-based cap: jdtls never registers in
   `~/.cache/agent-lsp/daemons/`, so an `agent-lsp daemon-stop` FIFO eviction
   reads an always-empty registry and does nothing. There is no resident jdtls
   accumulation (each in-process jdtls dies with its spawn); the only Java RAM
   pressure is the **concurrent** in-process jdtls set during overlapping
   codeIntel spawns — `N_concurrent_java_spawns × ~0.8–2 GB` (Findings 3–4; the
   per-jdtls plateau is ~2 GB on a large Maven repo, mil.1). This is **bounded
   and self-cleaning**, so no cap is built this cycle. If measured need arises
   (heavy parallel first-class Java use contending with the served model), the
   correct mitigation is a **spawn-concurrency limit** on codeIntel sessions with
   Java roots — a *supervisor-side* mechanism (the keepalive cannot mediate
   spawns) that would **cross the RDR-013 bright line** and therefore requires its
   own RDR. **Deferred**, not silently dropped: the operator guidance in the docs
   (item 3) states the concurrency math so a human can bound parallel Java use
   manually until then.
3. **Docs** — USER_GUIDE: TS/Go warm-reuse is automatic; jdtls is cold-per-spawn
   (self-cleaning) with the `.agent-lsp/cache.db.gz` cache recipe as the
   cold-start amortizer; the manual jdtls-concurrency guidance. ARCHITECTURE:
   broker ownership (TS/Go), the in-process jdtls model, and the unchanged
   teardown bright line.

### Out of scope (proposed)

- An ops-side **idle reaper** — **dropped.** agent-lsp self-reaps TS/Go brokers
  at ~30 min (Finding 1); jdtls is in-process and dies at teardown (Finding 4);
  neither needs an idle sweeper.
- A **registry-based resident-broker cap** (`daemon-stop` FIFO) — **retracted
  (Finding 4).** It is a structural no-op for jdtls (empty registry) and TS/Go
  are too cheap (~88 MB) to warrant capping. Superseded by the deferred
  spawn-concurrency mitigation (In-scope item 2).
- Building our own agent-lsp pool / shared HTTP service — agent-lsp's daemon
  already is one (YAGNI; same posture as RDR-014).
- Pre-warming every repo at boot — pre-warm only an explicit hot-repo list, if
  at all (deferred unless research shows first-cold dominates).
- Committing `.agent-lsp/cache.db.gz` into target repos — a per-repo operator
  decision, noted as a recipe only.

### Bright line (proposed)

The supervisor's teardown contract is **unchanged**: it still does not touch the
agent-lsp process tree (RDR-013). LSP lifecycle is owned entirely by agent-lsp —
TS/Go daemon-brokers (warm reuse + ~30 min idle self-reap) and in-process jdtls
(reaped at teardown) — never by the per-session abort path, and this cycle adds
**no** supervisor or keepalive code. Any future spawn-concurrency cap (In-scope
item 2) is a supervisor-side mechanism that would cross this line and is
therefore out of this RDR — it needs its own RDR.

### Approach (proposed — numbered for phase-review cross-walk)

1. Verify broker survival + reaping mechanics against the live tool — **DONE**
   (Findings 1–2, **TypeScript/Go**: survival confirmed; ~30 min idle self-reap
   measured; tsserver ~88 MB/root).
2. Verify jdtls lifecycle — **DONE (Finding 4)**: jdtls runs **in-process**, one
   shared instance per spawn, reaped at teardown, never in the registry. This
   **retracts** the original registry-cap plan (no-op for jdtls). Per-jdtls peak
   ~2 GB on a large Maven repo (mil.1). No cap is built this cycle;
   spawn-concurrency mitigation is **deferred** to a future supervisor-side RDR
   gated on measured need.
3. **Deferred (optional, not this cycle):** set `AGENT_LSP_BROKER_TIMEOUT_MS` in
   `applyCodeIntel`'s agent-lsp `env` (broker *start*-timeout headroom for large
   cold TS/Go repos — NOT an idle knob, and no effect on the in-process jdtls
   path, Finding 4).
4. **Deferred (optional, not this cycle):** pin an installed `agent-lsp` over
   `uvx agent-lsp` to drop the per-spawn resolve; weigh against the RDR-014
   "prereq not installed by us".
5. Docs: USER_GUIDE — TS/Go warm-reuse, jdtls cold-per-spawn + `.agent-lsp/cache.db.gz`
   cache recipe, manual jdtls-concurrency guidance; ARCHITECTURE — broker
   ownership (TS/Go) + in-process jdtls model + the unchanged teardown bright line.

## Research Findings

### Finding 1 — daemon-broker survives teardown; ~30 min idle self-reap (VERIFIED 2026-06-28, TypeScript/Go only)

> **Scope correction (2026-07-01):** everything in this finding was probed with
> **TypeScript** and holds for **TS/Go** (socket-registered daemon-broker). It
> does **NOT** generalize to jdtls — see Finding 4, which supersedes any implied
> jdtls broker behavior. Read "broker" below as "TS/Go broker".

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

> **Scope correction (2026-07-01):** the per-broker RSS below is a **TS/Go**
> (daemon-broker) measurement and stands. The "Java brokers / 30 min window /
> resident-broker cap" framing in the JVM bullet is **superseded by Finding 4**:
> jdtls is **not** a broker — it is in-process, held for the spawn's duration
> (not 30 min), and is bounded by a *spawn-concurrency* cap, not a resident-broker
> cap. Read the jdtls bullet through Finding 4.

- **Per-broker RSS** (warm, idle): the `agent-lsp daemon-broker` process ~22 MB
  + its `typescript-language-server` child ~66 MB ≈ **~88 MB per (root, ts)**.
  Negligible against the box (~32 GB system) / Mac (128 GB) budgets at any
  realistic root count.
- **The JVM caveat is jdtls.** Java roots spawn `jdtls` (a full Eclipse JDT
  JVM, typically 300 MB–1 GB+ resident; ~2 GB fully indexed, mil.1), so a burst
  of **concurrent** *Java* codeIntel spawns (each an in-process jdtls, Finding 4)
  is the only plausible footprint concern — not TS/Go.
- ⇒ Steady-state leak is a non-issue (TS/Go self-reap; jdtls dies at teardown).
  The residual risk is **peak** simultaneous in-process jdtls under bursty
  first-class Java use; a **spawn-concurrency** cap (Finding 4, In-scope item 2)
  is the candidate mitigation, deferred until a measured Java-heavy burst warrants
  it.

### Finding 3 — Java burst peak is material: ~1.7 GB per jdtls (MEASURED 2026-06-29; reframed 2026-07-01)

> **Reframe (2026-07-01, see Finding 4):** the RAM magnitude here stands, but its
> *mechanism* was misattributed. The original "3 separate jdtls processes / 5.1 GB"
> reading came from **3 separate stdio clients** (one `uvx agent-lsp` per root) →
> 3 independent **in-process** jdtls — i.e. it measured **concurrent-spawn RAM**,
> not 3 daemon-brokers. A one-client / three-`start_lsp` repro yields **one
> shared jdtls** (Java roots = workspace folders), 801 MB. So this finding is best
> read as: *K concurrent codeIntel spawns with Java roots ≈ K in-process jdtls,
> ~0.8–2 GB each.* The **"`daemon-stop` eviction lever works" conclusion is
> RETRACTED** — jdtls never registers in the daemon registry, so there was
> nothing to evict (Finding 4).

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
- Extrapolation (linear, lower-bound): 6 concurrent Java-root codeIntel spawns
  ≳ ~10 GB, held for the overlapping spawns' active duration (jdtls dies at
  teardown — Finding 4 — not the TS/Go 30 min idle window). On the box (~32 GB
  system carveout) and the Mac
  (128 GB unified, but the served model already takes ~42 GB+ and MLX runs
  `-w1`), an unbounded Java burst can contend with the model's RAM.
- `agent-lsp daemon-stop --root-dir=… --language=java` returned "0 jdtls, 0
  registry entries" post-run. **Originally read as "eviction works" — RETRACTED
  (Finding 4):** the registry was *already* empty (jdtls is in-process and had
  died on client close), so `daemon-stop` had nothing to evict. The lever does
  **not** apply to jdtls.

⇒ **Decision item 2 revised (see Finding 4): a registry-based resident-broker cap
is NOT applicable** — jdtls is not a broker. The RAM concern is real but is
*concurrent-spawn* footprint (bounded, self-cleaning), documented and deferred,
not capped this cycle. The per-jdtls peak (~1.7 GB floor here; ~2 GB on a large
Maven repo, mil.1) informs the manual concurrency guidance in the docs.
- **Persistent symbol cache** exists separately at `~/.agent-lsp/cache/`
  (committable as `.agent-lsp/cache.db.gz` — "teammates skip cold-start
  indexing"); amortizes cold-start across daemon restarts/machines.

Repro: drive agent-lsp over an MCP stdio client (`@modelcontextprotocol/sdk`),
inspect `~/.cache/agent-lsp/daemons/*/daemon.json` and `ps -o pid,etime,rss`.
bd memory: `codeintel-agentlsp-daemon-lifecycle-2026-06-28`,
`codeintel-roughedge-rootcause-2026-06-28`.

### Finding 4 — jdtls runs in-process, not as a daemon-broker (VERIFIED 2026-06-30/07-01; supersedes the jdtls generalization of Findings 1 & 3)

Re-verified against live `uvx agent-lsp` **0.15.0** + homebrew **jdtls 1.57.0**,
driving `uvx agent-lsp` via a minimal `@modelcontextprotocol/sdk` stdio client —
**the same invocation path `applyCodeIntel` uses** (RDR-014). Four probes, all
consistent; a TypeScript control confirms the rig is valid:

- **jdtls is in-process, not a broker.** Single apollo root
  (`start_lsp(root_dir, java, ready_timeout=180)`): the `org.eclipse.jdt.ls` JVM
  is a **child of the stdio `uvx agent-lsp`** (ppid = that process), the registry
  `~/.cache/agent-lsp/daemons/` stays at **0 entries**, and the jdtls **dies on
  client close**. Fully-indexed RSS ~**1.9 GB** (mil.1 plateau; ~2 GB planning
  figure, enterprise repos higher).
- **Not a broker-start-timeout fallback.** Same probe with
  `AGENT_LSP_BROKER_TIMEOUT_MS=180000`: identical (in-process, registry 0, dies
  on close). Raising the broker start timeout does not move jdtls onto the broker
  path.
- **One shared jdtls per client across Java roots.** Three roots via one client →
  a **single** shared jdtls (roots become workspace folders), registry 0.
- **Finding 3 reproduced exactly** (same 3 small libs, concurrent,
  `ready_timeout=60`, one client): **one shared jdtls, 801 MB total** (not 3 ×
  1.7 GB), registry 0, jdtls gone on close, and `daemon-stop --language=java`
  returned **"no running daemon found"** for all three roots — i.e. the original
  "eviction lever" was reaping nothing.
- **TypeScript control (same binary, same rig):** `start_lsp(root_dir, ts)`
  populates the registry (0→1) and the tsserver **survives** client close —
  reproducing Finding 1. So the jdtls divergence is agent-lsp behavior, not a
  test artifact. The agent-lsp binary special-cases jdtls
  (`internal/lsp.(*LSPClient).isJDTLS`).

⇒ **Consequences for the Decision:** (1) no cross-spawn warm reuse for jdtls —
each spawn pays a cold index (Decision item 1 scoped to TS/Go; cache is the jdtls
amortizer). (2) No resident jdtls accumulation and nothing in the registry to
evict — the registry `daemon-stop` FIFO cap is retracted (Decision item 2). (3)
The real Java RAM concern is *concurrent* in-process jdtls across overlapping
spawns (`K × ~0.8–2 GB`, spawn-lifetime, self-cleaning) — documented, with a
spawn-concurrency cap deferred to a future supervisor-side RDR.

*Caveats:* single environment (Mac, agent-lsp 0.15.0, jdtls 1.57.0); a config/env
that opts jdtls into broker mode was not found (env surface is
`AGENT_LSP_BROKER_TIMEOUT_MS`/`AUDIT_LOG`/`OUTPUT_FORMAT`/`TOKEN`). Re-verify on
agent-lsp/jdtls upgrade. bd memory: `codeintel-jdtls-inprocess-not-broker-2026-06-29`,
`codeintel-finding3-not-reproducible-2026-06-30`, `codeintel-jdtls-plateau-measured-2026-06-29`.

## Consequences

### Positive

- For **TypeScript/Go**, warm cross-spawn `start_lsp` reuse **and** idle reaping
  are **both already provided** by agent-lsp (measured) — first-class TS/Go use
  pays per-root indexing once and resident brokers self-bound at ~30 min idle.
- The supervisor needs **no change** and this cycle builds **no code at all** —
  the outcome is documentation of the real lifecycle. jdtls, though it gets no
  warm reuse, is **self-cleaning** (in-process, reaped at teardown, Finding 4),
  so there is no resident leak to manage and no ops surface to maintain.

### Negative

- Peak Java-burst footprint is **confirmed material** (Findings 3–4): ~0.8–2 GB
  per in-process jdtls. But it is held **only for the spawn's lifetime**, not
  30 min — jdtls is not a broker (Finding 4), so it dies at teardown. The
  footprint scales with **concurrent** Java-bearing codeIntel spawns, and there
  is **no working automatic cap this cycle** (the registry `daemon-stop` cap was
  a no-op and is retracted). Java-heavy parallel first-class use is bounded
  **manually** (operator guidance) until a supervisor-side spawn-concurrency cap
  is designed in a follow-up RDR.
- jdtls gets **no warm cross-spawn reuse** (Finding 4): every codeIntel spawn
  with Java roots pays a full cold `start_lsp` index. The only cold-start
  amortizer is the persistent `.agent-lsp/cache.db.gz` symbol cache — a per-repo
  operator choice, not something the supervisor can provide.

### Neutral

- The supervisor stays out of LSP lifecycle entirely (RDR-013 bright line
  intact); all lifecycle logic lives in agent-lsp (TS/Go brokers + in-process
  jdtls). This cycle adds no keepalive code either.
- codeIntel posture stays **opt-in**. **TS/Go-only use is safe today** (warm
  reuse + ~30 min self-reap, trivial footprint). **Java-heavy first-class use is
  NOT automatically bounded** — the concurrent in-process jdtls footprint is
  self-cleaning but uncapped; operators bound it manually (limit simultaneous
  Java-root codeIntel spawns so `K × ~2 GB` fits headroom) until a
  spawn-concurrency cap ships in a follow-up RDR.
