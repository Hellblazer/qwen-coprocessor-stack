---
name: Multi-Qwen fleet management — declarative config, tmux-as-lifecycle, mosh-attached operator UX
type: architecture
status: draft
priority: high
created: 2026-05-04
authors:
  - hal.hildebrand
related:
  - RDR-001 §D3 (multi-backend routing with session affinity — runtime)
  - RDR-001 §Q4 (pool cap and reaper — interaction with hot-reload)
  - RDR-001 §S2 (backend failure recovery — interaction with declared fleet)
  - RDR-003 (per-backend metrics from the agent flow into the same Prometheus surface)
---

# RDR-004 — Multi-Qwen fleet management: declarative config, tmux-as-lifecycle, mosh-attached operator UX

## Status

**Draft** (2026-05-04). The supervisor's runtime control plane —
`Backend[]`, the 6-step router, health cache, KV-cache affinity per
`task_id` — already supports multi-backend deployment. RDR-001 §S5
deliberately deferred the *operator* control plane (how a human
expresses, brings up, observes, and tears down a fleet of
llama-server instances across machines) to a follow-up. This RDR is
that follow-up.

## Context

RDR-001 imagined a Mac M4 Max running one llama-server (Metal,
27B Q6) and aspirationally a Strix Halo box running a heavier Qwen
variant (Vulkan, 35B-A3B MoE) plus possibly more. The runtime
plumbing assumed all of these are reachable HTTP endpoints and the
supervisor doesn't care how they got there. It punted on the lived
experience of *getting them there*.

That experience today, with what RDR-001 shipped:

1. Operator opens an SSH session to the Strix Halo box.
2. Manually starts a `llama-server` with the right model path, port,
   context size, GPU layers — by hand, every time, against memory.
3. Disowns the process or wraps in `nohup` so closing the SSH session
   doesn't kill it.
4. SSHes back to confirm it's healthy via `curl localhost:9000/health`.
5. Updates the supervisor's `QWEN_BACKENDS` env var — which is JSON,
   inside a shell-quoted string, in a place that's a pain to edit
   live.
6. Restarts the supervisor — which kills every in-flight session.
7. Whenever something goes sideways, opens a fresh SSH session to
   `tail -f` a log file whose path they've half-remembered.
8. When the laptop suspends or the network roams, every observation
   session breaks; reconnect-and-rediscover starts over.

Each step in isolation is fine. The composition is hostile to anyone
who actually wants to run a fleet bigger than one. The friction
compounds, and the natural response is "just run one local Qwen and
call it done" — exactly the regression RDR-001 §D3 tried to prevent.

The aim of this RDR is to design a **management surface** that makes
running a multi-machine, multi-instance Qwen fleet feel like the
single-instance case. Two distinct control planes, kept clearly
separate:

- **Runtime control plane** (already built): supervisor → llama-server.
  Stateless HTTP. Backends are URLs. The supervisor doesn't care how
  they got there.
- **Operator control plane** (this RDR): human → fleet. Declarative
  state, lifecycle, observation. The supervisor receives updates from
  it; it does not drive the supervisor.

This separation matters because conflating them is the standard way
these systems collapse into a too-clever orchestrator that fails
opaquely.

## Decision drivers

- **D1. Declarative fleet definition.** A single config file expresses
  the entire desired state across hosts. `qwenctl apply` reconciles.
  Imperative "run this command on that host" is a smell — it makes
  partial-state recovery undefined.

- **D2. Tmux-as-lifecycle.** The existence of a named tmux window IS
  the lifecycle signal — no PID files, no signal-handling, no
  out-of-band liveness tracking. Killing the window stops the
  llama-server cleanly (SIGTERM via `tmux send-keys C-c`, then a
  short grace period). This eliminates an entire class of "did it
  start? did it stay started? did the daemonization work?" failures
  that haunt SSH-driven imperative scripts.

- **D3. Mosh for operator transport.** Operator workflows involve
  long attached sessions with arbitrary network topology — laptops
  closing lids, switching networks, idle SSH timeouts. Mosh's
  UDP-based predictive transport survives all three at the
  connection layer; tmux survives them at the session layer. The
  composition is the right tool for "watch a fleet over many hours,
  intervening when needed."

- **D4. Single-pane-of-glass observation per host.** `qwenctl
  attach <host>` drops the operator into a tmux dashboard that's
  already laid out: status window with live `qwenctl ps`, one
  window per running instance with pre-split panes for log tail
  and host stats, plus a free shell window. No tmux fluency
  required — the layout is canonical.

- **D5. Hot-reload of supervisor backends.** Adding or removing a
  remote llama-server must NOT require restarting the supervisor.
  Restart kills every in-flight `task_id`; the lived RDR-001 §S2
  recovery path is a fallback for backend death, not a routine
  workflow.

- **D6. Idempotent and crash-safe.** Every operator command is safe
  to re-run. `qwenctl up <inst>` against an already-running instance
  is a no-op. Partial failures heal on retry. No "what's the
  current state?" question goes unanswered for longer than a
  10-second `qwenctl ps`.

- **D7. Heterogeneous host architectures.** Mac (Metal), Linux/Vulkan
  (Strix Halo), eventually Linux/CUDA. Setup paths and `llama-server`
  flags differ per arch. Per-host config in the fleet file picks the
  right binary and inference backend.

- **D8. Minimal authority on remotes.** No root, no system services,
  no daemons enabled at boot. Everything runs as the operator's
  user under `~/.qwen-fleet/`. Hosts that survive reboot do so by
  the operator running `qwenctl apply` — explicit, not magical.

- **D9. No load-bearing custom protocol.** Where standard tools
  (tmux, SSH, mosh, HTTP) suffice, use them. The agent that bridges
  RPC to tmux is small and stateless precisely so we never argue
  about its protocol.

## Options considered

### Option A — SSH-driven imperative shell scripts

`qwenctl up strix:foo` runs `ssh strix '/path/to/start-foo.sh'`. Each
host has its own start scripts. `nohup` + `&` + `disown` for daemonization.

- ✅ Zero new components
- ❌ Daemonization story is a footgun (terminal hangups, orphan
  processes, log file races)
- ❌ Reconnect-to-observe is `ssh + tail -f` — no central view (D4
  fails)
- ❌ Crash-safety: a half-finished `apply` leaves unknown state on
  the remote
- ❌ No standardized status — every script invents its own probe

Rejected. This is essentially the current friction floor.

### Option B — systemd user units on each remote

Generate `.service` files, push via SSH, `systemctl --user enable
--now <inst>`. Status via `systemctl --user status`.

- ✅ Robust process supervision; survives operator disconnect
- ✅ Built-in restart, log capture (journalctl)
- ❌ Linux-only — breaks D7 for the Mac local case (which we still
  care about, since the Mac IS one of the fleet hosts)
- ❌ Requires `loginctl enable-linger` on every host, which
  requires sudo (breaks D8)
- ⚠️ Per-instance config drift: editing a `.service` file by hand to
  tune `--gpu-layers` undoes the declarative property
- ⚠️ Operator UX (`systemctl status <inst>`) is fine but not the
  single-pane-of-glass we want

Rejected. The cross-OS constraint is dispositive.

### Option C — A long-running agent daemon on each host

A `qwen-fleet-agent` daemon listens on an HTTP socket, manages local
llama-server processes itself (spawn, supervise, restart, status).
`qwenctl` calls into it. The supervisor pulls config from it.

- ✅ Cross-platform (just a binary)
- ✅ Rich introspection — agent knows everything
- ❌ Supervision tree depth: agent supervises llama-server; who
  supervises agent? `nohup` again, or fall back to systemd/launchd
  (which we just rejected)
- ❌ Agent crash drops state; restart needs careful reconciliation
- ❌ Protocol drift over time — every feature adds an endpoint
- ⚠️ Heavy: 5000+ LoC if done with proper supervision logic

Rejected as the primary mechanism; partially adopted for status RPC
in Option E.

### Option D — Tmux-as-lifecycle, SSH/mosh for transport, no agent

`qwenctl` SSHes to the remote and runs `tmux` commands directly.
Each instance is a tmux window in a per-host session named
`qwen-fleet`. Existence of the window means "running"; killing it
stops the server. `qwenctl ps` parses `tmux list-windows` output
remotely. `qwenctl attach <host>` resolves to `mosh <host> -- tmux
attach -t qwen-fleet`.

- ✅ Cross-platform — tmux runs everywhere we care about
- ✅ Lifecycle and observation surface are one and the same — no
  duplicate "agent thinks it's running" / "tmux says it's not"
- ✅ Operator gets the dashboard for free — they're attaching to
  the *real* runtime state, not a copy
- ✅ Crash-safe: agent failure modes don't exist because there's
  no agent. SSH transport flakiness at most fails a command, never
  damages state
- ⚠️ Status queries to the supervisor (the hot-reload path) need
  *something* HTTP-shaped — supervisor can't shell out to SSH on
  every reload
- ⚠️ Tmux output parsing is shell-text fragile

Mostly correct, but the supervisor-side hot-reload story needs an
HTTP-shaped surface. This is what Option E adds.

### Option E — Tmux-as-lifecycle + tiny stateless RPC agent for status (HYBRID)

Option D's tmux-as-lifecycle, plus a small stateless `qwen-fleet-agent`
on each host that exposes an HTTP RPC interface:

- `GET /instances` returns the current state (parsed from `tmux
  list-windows` + procfs).
- `POST /instances/<id>/start` runs the tmux command to add a window.
- `POST /instances/<id>/stop` kills the window.
- `GET /healthz` for the agent itself.

The agent is *stateless*: restarting it does not touch tmux or
llama-server. Tmux is the source of truth; the agent is a thin
HTTP-shaped reader/writer of it.

- ✅ Tmux-as-lifecycle still owns liveness and observation
- ✅ Supervisor's hot-reload calls `GET /instances` over HTTP — no
  SSH dependence in the runtime path
- ✅ Agent is small (~300 LoC, single binary), trivially restartable,
  no recovery logic
- ✅ Cross-platform via Go cross-compile
- ⚠️ One more thing to bootstrap; mitigated by `qwenctl bootstrap`

**Decision: Option E.** Tmux is the lifecycle and observation; a
stateless agent provides the HTTP surface for the supervisor's
hot-reload. `qwenctl attach` continues to use mosh+tmux directly,
not the agent — because the agent is for machine-to-machine RPC,
not human attachment.

## Decision

A four-component system, layered:

1. **`fleet.toml`** — declarative state.
2. **`qwenctl`** — operator CLI; reconciler.
3. **`qwen-fleet-agent`** — stateless HTTP→tmux adapter on each host.
4. **Supervisor changes** — file-watch + SIGHUP for backend hot-reload.

### `fleet.toml` — declarative fleet

Stored at `$XDG_CONFIG_HOME/qwen-fleet/fleet.toml` (default
`~/.config/qwen-fleet/fleet.toml`). One file describes the whole
fleet:

```toml
# fleet.toml

[host.mac-local]
transport     = "local"            # operator workstation; no SSH
arch          = "darwin-arm64"
inference     = "metal"
models_dir    = "/Users/hal/git/qwen-coprocessor-stack/models"
llama_bin     = "/Users/hal/src/llama.cpp/build/bin/llama-server"

[host.strix]
transport     = "ssh"              # plus mosh for operator attach (see attach.transport)
ssh_target    = "hal@strix.local"
ssh_options   = ["-o", "ControlMaster=auto", "-o", "ControlPersist=10m"]
arch          = "linux-x86_64"
inference     = "vulkan"
models_dir    = "/srv/qwen/models"
llama_bin     = "/usr/local/bin/llama-server"

[host.strix.attach]
transport     = "mosh"             # operator-attach uses mosh; ssh fallback
mosh_options  = ["--predict=adaptive"]

[[instance]]
id            = "local-27b"
host          = "mac-local"
model_file    = "Qwen3.6-27B-UD-Q6_K_XL.gguf"
model_alias   = "qwen3.6-27b-instruct"
port          = 8080
context       = 65536
gpu_layers    = 99
cache_type_k  = "q8_0"
cache_type_v  = "q8_0"
capacity      = "heavy"
tier          = "local"
weight        = 1

[[instance]]
id            = "strix-35b"
host          = "strix"
model_file    = "Qwen3.6-35B-A3B-Q4_K_M.gguf"
model_alias   = "qwen3.6-35b-a3b"
port          = 9000
context       = 131072
capacity      = "heavy"
tier          = "remote"
weight        = 2

[[instance]]
id            = "strix-7b"
host          = "strix"
model_file    = "Qwen3.6-7B-Instruct-Q8_0.gguf"
model_alias   = "qwen3.6-7b-instruct"
port          = 9001
context       = 32768
capacity      = "fast"
tier          = "remote"
weight        = 1
```

Key properties:

- **Hosts and instances are first-class.** Operators add a remote
  by adding one host block and N instance blocks; no code changes.
- **No secrets in fleet.toml.** SSH auth comes from the user's
  `~/.ssh/config` and `ssh_options`. No tokens, no keys in the
  fleet file.
- **Per-instance flags map directly to llama-server arguments.**
  No translation layer to drift.
- **Capacity and tier are the same labels the supervisor's router
  uses** (RDR-001 §Routing). `qwenctl apply` writes them through
  unchanged.

### `qwenctl` — operator CLI

Single Go binary. Commands:

| Command                              | Effect |
|--------------------------------------|--------|
| `qwenctl ps`                         | Fleet-wide table: id, host, port, state, uptime, model, KV-cache hit, mem |
| `qwenctl up [INST...]`               | Bring up instances (default: all not running). Idempotent. |
| `qwenctl down [INST...]`             | Stop instances. Sends SIGINT into the tmux window's pane; waits 5 s; kills window if still running. |
| `qwenctl restart [INST...]`          | down → up |
| `qwenctl logs INST [-f]`             | Stream the instance's log (mediated by agent, which reads the tmux pane history + the on-disk log) |
| `qwenctl attach [HOST]`              | mosh + tmux attach to the host's `qwen-fleet` session |
| `qwenctl status`                     | Supervisor view: configured backends, health, in-flight sessions |
| `qwenctl apply [FILE]`               | Reconcile: apply fleet.toml. Default `~/.config/qwen-fleet/fleet.toml` |
| `qwenctl diff [FILE]`                | Show what `apply` would change (no execute) |
| `qwenctl bootstrap HOST`             | Deploy `qwen-fleet-agent` + check tmux/mosh availability |
| `qwenctl pull-model HOST FILE`       | rsync a model file from local to the host's `models_dir` |
| `qwenctl reload-supervisor`          | Tell `qwen-agent-server` to re-read backends |
| `qwenctl shell HOST`                 | mosh into HOST (no tmux) — quick escape hatch |
| `qwenctl tmux HOST [WINDOW]`         | Send a tmux command to the host's session — escape hatch for advanced ops |

Reconciliation algorithm (`qwenctl apply`):

```
1. Parse and validate fleet.toml.
2. Resolve cross-host dependencies: bootstrap missing agents.
3. For each host in fleet.toml:
   a. Connect to qwen-fleet-agent at the host's well-known socket.
   b. Diff (declared instances on this host) vs (running instances per agent).
   c. For new instances: POST /instances/<id>/start; wait for llama-server /health.
   d. For removed instances: POST /instances/<id>/stop after a drain check
      (see "Drain semantics" below).
   e. For changed instances (port, model, context, etc.): restart in place.
4. Generate $XDG_CONFIG_HOME/qwen-agent-server/backends.json (the
   supervisor's read-only backend list).
5. Send the supervisor a reload (SIGHUP or MCP qwen_reload_backends).
6. Print qwenctl ps for confirmation.
```

The reconcile is deterministic and idempotent — re-running `apply`
without changing `fleet.toml` is a no-op.

### `qwen-fleet-agent` — the small one

Single Go binary. Built statically, cross-compiled for `darwin-arm64`,
`linux-x86_64`, `linux-arm64`. ~300 LoC.

Listens on `~/.qwen-fleet/agent.sock` (Unix socket; reachable
remotely via SSH local-forward — `qwenctl` opens the forward
transparently).

Endpoints:

```
GET  /healthz                       → 200 OK with version
GET  /instances                     → [{id, port, state, started_at, model, pid}]
GET  /instances/<id>                → single record
POST /instances/<id>/start          → idempotent; body has the instance config
POST /instances/<id>/stop           → idempotent
GET  /instances/<id>/log?since=...  → log content from the on-disk log file
GET  /tmux/session                  → name of the tmux session this agent manages
```

Internally the agent shells out to `tmux` for state changes — `tmux
new-session -d -s qwen-fleet`, `tmux new-window -n <id>`,
`tmux send-keys`, `tmux kill-window`. State queries parse `tmux
list-windows -F`. No state held in-process beyond a config snapshot
for the current request.

Restarting the agent: kills the agent, restart from scratch. Tmux
session and llama-server processes untouched. The next `qwenctl ps`
re-reads tmux state.

### Tmux session layout (per host, session name `qwen-fleet`)

```
window 0: status     │ qwenctl ps --host=<this> --watch
window 1: <inst-1>   │ pane 0: tail -f logs/<inst-1>.log │ pane 1: nvtop|btop|powermetrics
...
window N: <inst-N>   │ same template
window 99: shell     │ free shell
```

The status window auto-refreshes once per second. Per-instance
windows are split horizontally; the right pane runs the
host-appropriate observability tool (`nvtop` for Vulkan,
`powermetrics` on Mac, `btop` as fallback).

The layout is built by the agent on `start`; the operator never
arranges panes by hand. `tmux-resurrect` is recommended but not
required — explicitly NOT enabled by default. Reboot wipes the
fleet; operator re-runs `qwenctl apply` on next session. This
matches D8 (no boot-time daemons) and avoids surprising
auto-resurrection.

### Operator-attach flow

```
$ qwenctl attach strix
[qwenctl] mosh hal@strix.local --predict=adaptive -- tmux attach -t qwen-fleet
```

The operator now sees a live, multi-window dashboard. The terminal
disconnects (lid close, network change, suspend) → mosh holds the
roaming session → tmux holds the work session → on reattach, all
state intact. Dropping out of mosh by `Ctrl+^ .` (mosh's
disconnect) leaves both alive on the remote.

`qwenctl attach` with no host argument prompts for a choice
(zero-arg interactive picker); useful when `fleet.toml` defines
many hosts.

For hosts where mosh isn't available (`host.<name>.attach.transport
= "ssh"` or unset), `qwenctl attach` falls back to `ssh -t … tmux
attach`. Operator loses the roaming property but everything else
works.

### Supervisor changes

`qwen-agent-server` gains:

- `--fleet-config <path>` flag pointing at the supervisor-readable
  backend list (`backends.json`, generated by `qwenctl apply`).
  When unset, fall back to current `QWEN_BACKENDS` env var.
- A SIGHUP handler that re-reads the fleet config and reconciles
  `pool.backends` with a diff:
  - **New backend:** added to `pool.backends`. First spawn against
    it triggers a cold `getCachedHealth` probe.
  - **Removed backend:** entered "drain mode" (RDR-001 §S2 close
    cousin). New `qwen_spawn` calls cannot route to it. Existing
    sessions keep running until they finish or stop. After all
    drained, the backend is dropped from `pool.backends`.
  - **Changed backend (e.g. capacity reclassified):** treated as
    remove+add; existing sessions on the old definition complete
    before the new entry is reachable.
- A new MCP tool `qwen_reload_backends` (admin-only, gated on
  `QWEN_ADMIN_TOOLS=1`) that performs the same reload from inside
  Claude Code.
- An optional `fs.watch` on the fleet-config file: any change
  triggers an internal SIGHUP. Off by default (avoids edit-in-place
  surprises); enable with `QWEN_FLEET_WATCH=1`.

### Bootstrap workflow

```
$ qwenctl bootstrap strix
[1/5] connecting to hal@strix.local …  ok (uname=Linux x86_64)
[2/5] checking tmux …  ok (3.4)
[3/5] checking mosh-server …  ok (1.4.0)
[4/5] uploading qwen-fleet-agent (linux-x86_64) → ~/.qwen-fleet/bin/  ok
[5/5] starting agent in tmux session qwen-fleet, window agent …  ok
       agent listening on ~/.qwen-fleet/agent.sock
       version 0.1.0, healthz: 200 OK

llama.cpp build: NOT FOUND at /usr/local/bin/llama-server
        Run scripts/setup-strix-halo.sh to build llama.cpp with Vulkan support,
        then re-run `qwenctl apply` to bring up declared instances.

Suggested fleet.toml additions (paste into your fleet.toml):

[host.strix]
transport   = "ssh"
ssh_target  = "hal@strix.local"
arch        = "linux-x86_64"
inference   = "vulkan"
models_dir  = "/srv/qwen/models"
llama_bin   = "/usr/local/bin/llama-server"

[host.strix.attach]
transport   = "mosh"
```

Bootstrap is idempotent: re-running on an already-bootstrapped host
upgrades the agent binary in place (a brief restart) and re-prints
the suggested config block.

### Drain semantics

When an instance is removed from `fleet.toml` and the supervisor
diffs the change:

- Mark the backend `draining` in the pool.
- `qwen_spawn` excludes draining backends from candidate selection.
- Existing sessions continue. Each session's `qwen_poll` reflects
  the backend status if asked.
- Once all sessions on the draining backend reach `complete`/`error`/
  evict-by-stop, the backend is removed.
- A timeout (default 30 min, override via `QWEN_DRAIN_TIMEOUT_MS`)
  caps drain wait. After timeout, sessions on the drain target are
  forcibly errored with `code=backend_drained`, mirroring §S2's
  `last_known` payload so callers can re-spawn elsewhere.

`qwenctl down INST` (vs. removing from fleet.toml) is more
aggressive: SIGINT to llama-server, 5 s grace, kill window. The
supervisor sees the backend's health probe fail and surfaces
`backend_offline` to any sessions still on it. The operator chose
this, so the abrupt failure is intended.

### Failure mode catalog

| Failure                                            | Consequence                                                                 |
|----------------------------------------------------|-----------------------------------------------------------------------------|
| Operator's laptop suspends mid-`attach`            | Mosh roams; tmux session intact. Reattach: state preserved.                 |
| SSH transport flakes during `qwenctl up`           | Operation idempotent; re-run. tmux windows are named — already-started instances skipped. |
| `qwen-fleet-agent` crashes                          | Tmux + llama-servers unaffected. `qwenctl ps` falls back to last-cached state until agent restart. |
| llama-server crashes inside its tmux window        | Pane shows the crash. `qwenctl ps` reports `crashed`. `qwenctl restart <id>` recreates. |
| Network partition between operator and remote      | Supervisor's health probe marks remote unhealthy → routes around. Sessions on that backend follow §S2 (error + last_known). |
| Operator forgets `qwenctl down` before laptop reboot | Remote llama-servers continue (tmux survives operator reboot). `qwenctl ps` reconciles on next run. |
| Remote host reboots                                | Tmux session lost; llama-servers gone. Next `qwenctl apply` re-creates. Supervisor health probe drains affected backends per §S2. |
| Conflict: a model file expected by `fleet.toml` doesn't exist on the host | Bootstrap-time check fails with a clear error and a `qwenctl pull-model` suggestion. |
| Two `qwenctl apply` invocations race               | Each operates against the agent's HTTP surface, which serializes. Last write wins; both see the post-state via `ps`. |

### Implementation map

```
qwenctl/                         (new repo; or scripts/qwenctl/ subdir to start)
  cmd/qwenctl/                   Go main; CLI surface
  internal/agent/                HTTP client for qwen-fleet-agent
  internal/fleet/                fleet.toml parser, validator, differ
  internal/ssh/                  SSH/mosh transport with control-master
  internal/supervisor/           reload-supervisor (SIGHUP + MCP)
  internal/tmux/                 tmux command helpers (used directly by qwenctl
                                 for `attach` / `tmux` escape hatches)

qwen-fleet-agent/                (new; same repo or sibling)
  cmd/qwen-fleet-agent/          Go main; HTTP server on unix socket
  internal/tmux/                 tmux read/write
  internal/instance/             llama-server config rendering + status

mcp-bridges/qwen-agent-server/
  src/fleet-config.ts            (new) parse backends.json
  src/fleet-watch.ts             (new) optional fs.watch
  src/server.ts                  (modified) SIGHUP handler, qwen_reload_backends
  src/pool.ts                    (modified) drain semantics
```

The agent and qwenctl are both Go: cross-compile is one command per
target arch, no runtime needed on the remote, single-file deploy
matches D8.

## Consequences

### Positive

- A multi-host Qwen fleet is expressible in one TOML file; bringing
  it up is one command (`qwenctl apply`).
- Tmux-as-lifecycle eliminates daemonization quirks; the operator
  attaching with mosh sees the *real* runtime, not a status mirror.
- Mosh + tmux together survive every laptop-class disconnect mode
  without operator action.
- Hot-reload preserves in-flight sessions across config changes —
  fixes the "restart kills all the work" friction that motivates
  this RDR.
- The agent is small enough (~300 LoC) that "what does it do?" has
  a one-paragraph answer; no recovery state, no protocol drift.
- Operators get a single-pane-of-glass dashboard per host without
  any custom UI code — tmux is the UI.
- The two control planes (runtime: supervisor; operator: qwenctl)
  remain cleanly separate. Failure in one doesn't propagate.

### Negative

- Tmux is now load-bearing on every remote. Hosts without tmux
  can't host instances. Bootstrap detects and reports; install
  guidance documented.
- Mosh is recommended, not required. Hosts without mosh lose
  laptop-roam — fallback to plain SSH attach. Operator picks.
- One more daemon to compose with the supervisor
  (`qwen-fleet-agent`). Stateless and single-binary, but still a
  thing to deploy.
- Out-of-band changes (someone hand-launches a llama-server) are
  invisible to `qwenctl ps`. This is correct (declarative is the
  point) but operators must internalize "if it's not in fleet.toml,
  it doesn't exist to qwenctl."
- A second binary toolchain (Go) joins the project — a TypeScript
  supervisor and Go ops tooling.
- `qwenctl reload-supervisor` is a separate explicit step (or
  opt-in `fs.watch`). Keeps the supervisor from reacting to a
  half-edited file mid-apply.

### Neutral

- Cross-platform Go binary build chain: trivial via standard
  cross-compile.
- `fleet.toml` adds a config format; TOML chosen because it's
  human-editable and has a stable Go parser. JSON would also work.
  YAML rejected (whitespace gotchas in operator-edited files).
- `~/.qwen-fleet/` directory layout introduces a per-host on-disk
  convention. Documented in bootstrap output.

## Research findings (open questions)

### Q1 — Agent binary language

**Status:** Tentative — Go.

Go for cross-compile ergonomics (one toolchain produces every
target), single-binary deploy, fast startup, and a strong tmux/SSH
ecosystem (`os/exec`, `golang.org/x/crypto/ssh`). Rust would yield
a smaller binary; the size delta isn't worth a second toolchain.

Consider: are there Node.js packages that ship as standalone binaries
(`pkg`, `nexe`) that would let us reuse the supervisor's TypeScript?
A spike could verify but the size-on-disk cost (40-80 MB embedded
Node) makes it unattractive vs. a 10 MB Go binary. Default Go;
revisit only if a bridging argument appears.

### Q2 — tmux output parsing fragility

**Status:** Open. Plan: use `tmux list-windows -F '#{...}' format
strings` exclusively, never parse human-readable output.

`tmux` provides a stable format-string vocabulary. The agent's
parsers should never crack human-readable lines. A few unit tests
fix the parser around a snapshot of `tmux 3.x` format output to
detect future drift.

### Q3 — Auth between qwenctl and the agent's unix socket

**Status:** Resolved as: SSH local-forward + unix socket perms.

`qwenctl` opens an SSH connection to the host (using SSH config
auth) and forwards the agent's unix socket to a local socket. HTTP
calls go over the forward. Authentication = "you have SSH access
to the host." No agent-side tokens, no certs. Matches D8.

For local-host (`mac-local`), the socket is at `~/.qwen-fleet/agent.sock`
directly; permissions `0600` so only the operator user can talk to
it.

### Q4 — Should the agent stream live tmux pane content?

**Status:** Deferred.

`qwenctl logs <inst> -f` could either tail the on-disk log file
(simple, doesn't see live stdout if logging is buffered) or stream
the tmux pane's history (`tmux capture-pane -p -J`) at intervals
(complete, but heavier).

Lean: hybrid — first read pane history once (catches anything not
yet flushed to disk), then `tail -f` the on-disk log. Implementation
detail; document as expected behavior.

### Q5 — What about tmux-resurrect for survival across host reboot?

**Status:** Resolved as: NOT default-enabled.

Auto-resurrecting llama-servers on host reboot surprises operators
("why is the GPU at 100% — I didn't start anything") and may silently
load stale model paths after a model directory rename. Explicit
`qwenctl apply` post-reboot is the right semantic.

Operators who *want* persistence can install tmux-resurrect manually;
they're informed but on their own.

### Q6 — Concurrent operator activity (two humans, same fleet)

**Status:** Open.

Two operators running `qwenctl apply` simultaneously is rare but
needs a clear answer. Options:

- (a) Lock fleet.toml by file lock for the duration of apply.
- (b) Lock the agent socket per host.
- (c) Last-write-wins; both see the post-state.

Lean: (b) — the agent's request handler serializes start/stop on a
per-instance lock. fleet.toml locking is harder (it's on the
operator's workstation, not the agent's host). Acceptable race:
both invocations succeed in different orders; the eventual state is
deterministic given the final fleet.toml.

### Q7 — Multi-supervisor (multiple Mac workstations sharing one Strix Halo)

**Status:** Out of scope; revisit if the use case lands.

Today the supervisor and qwenctl coexist on one machine. If two
operators on different workstations point at the same Strix Halo,
their `fleet.toml`s could conflict.

Two readings:

- Each workstation runs its own supervisor; the Strix llama-servers
  are a shared resource. Then who owns `fleet.toml`? — needs
  arbitration.
- One workstation is "primary"; the other reads. Supervisor's
  `qwen_backends` tool already supports this read shape.

No code changes here; the design holds with single-supervisor. Flag
for RDR-005 if multi-operator becomes real.

### Q8 — Do we need cross-host model storage?

**Status:** Resolved as: per-host `models_dir`. `qwenctl pull-model`
moves model files between hosts (rsync). No shared filesystem
assumed. Each host has its own copy.

For a fleet of 3-5 hosts and ~25 GB models, total disk cost is
acceptable. Operators with many hosts and many models can switch to
a shared NFS path manually — `models_dir` accepts any path.

## Related decisions and prior art

### Within this project

- **RDR-001 §D3** — multi-backend routing with session affinity.
  This RDR is the operator counterpart.
- **RDR-001 §Q4** — pool cap, idle reaper, LRU eviction. Hot-reload
  must respect the running-session protection (reaper skips
  running; lruEvict is the cap backstop).
- **RDR-001 §S2** — backend failure recovery. Drain semantics here
  are a planned variant: same `last_known` payload, different
  triggering reason (`backend_drained`).
- **RDR-003** — per-backend metrics. The agent emits its own
  `/metrics` (host stats: GPU%, mem); the supervisor emits its own
  (routing). Operators join by `backend_id` in Grafana.

### External

- **tmux** — https://github.com/tmux/tmux. The lifecycle and
  observation foundation. Stable since 2009; format strings are a
  documented API.
- **mosh** — https://mosh.org. UDP-based predictive transport over
  SSH-authenticated channel. Survives roaming, suspend, latency.
- **Hashicorp Nomad** — declarative workload management with a
  similar "agent on each host" shape. Heavier; full-blown
  scheduler. Right model for 100 hosts; overkill for 5.
- **Kubernetes** — the natural large-fleet answer. Rejected on
  scope: deploying the supervisor against k8s introduces a control
  plane of its own and a namespacing/auth model we don't need.
- **HashiCorp Boundary, Tailscale** — networking layer for
  multi-host. Out of scope: the operator's network model
  (LAN, VPN, or Tailscale already in place) is independent.
- **llama-swap** — https://github.com/mostlygeek/llama-swap. A
  model-swap server for llama.cpp. Different problem (model
  swapping inside one process); could be combined with this RDR's
  fleet model where one host runs a single llama-swap-serving
  llama-server fronting many models.

## References

- `mcp-bridges/qwen-agent-server/src/backends.ts` — `Backend` type,
  router. The runtime side this RDR feeds into.
- `mcp-bridges/qwen-agent-server/src/pool.ts` — pool cap, eviction,
  reaper. Drain semantics extend `removeSession`.
- `mcp-bridges/qwen-agent-server/src/server.ts` — handler factory.
  `qwen_reload_backends` lives here; SIGHUP wires through.
- `scripts/setup-strix-halo.sh` — placeholder build script for the
  Linux/Vulkan host. Bootstrap suggests it.
- `scripts/start-stack.sh`, `scripts/stop-stack.sh` — local-host
  llama-server lifecycle. `qwenctl up` for `host.<name>.transport
  = "local"` is a thin wrapper around these.
