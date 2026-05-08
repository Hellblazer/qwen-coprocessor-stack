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

**Design revision (2026-05-04):** an earlier draft of this RDR
introduced a stateless `qwen-fleet-agent` HTTP→tmux adapter on each
host. On review, that component carried no weight: the supervisor
never needs to talk to a remote agent (it reads `backends.json` on
the local workstation and probes `backend.url` directly), and
`qwenctl` can SSH-exec tmux commands without one. The agent has been
removed from the design. Option D below is the chosen approach;
Option E (with-agent) is retained as a "considered, not now"
alternative for future restricted-network scenarios.

**Strix Halo deployment decision (2026-05-04):** the heavier remote
host (Strix Halo / Ryzen AI MAX+ 395 / Radeon 8060S, gfx1151) will
run native Linux (Fedora 43 or Ubuntu 24.04 HWE / 26.04). Research
summary at `/tmp/strix-halo-linux-production.md`: Linux + Vulkan
(RADV) is the highest-throughput path for Qwen 30B-class MoE
(65–87 t/s vs. ~10–15% slower on native Windows; WSL2 is broken for
this workload due to CPU-fallback Vulkan and `hipMallocManaged`
constraints). With Linux confirmed on the Strix box, the fleet
design needs no platform-specific carve-outs — tmux, mosh, SSH,
bash, and the `qwen-extensions-wrapper.sh` (RDR-002) all work
uniformly across Mac and Linux hosts. Setup script:
`scripts/setup-strix-halo.sh` carries the concrete recipe.

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

### Option D — Tmux-as-lifecycle, SSH/mosh for transport, no agent (CHOSEN)

`qwenctl` SSH-execs `tmux` commands directly on the remote. Each
instance is a tmux window in a per-host session named `qwen-fleet`.
Existence of the window means "running"; killing it stops the
server. `qwenctl ps` runs `tmux list-windows -F '<format-string>'`
over SSH and parses the structured output. `qwenctl attach <host>`
resolves to `mosh <host> -- tmux attach -t qwen-fleet`.

The supervisor does NOT call into the remote at all. It reads
`backends.json` from the local workstation (written by `qwenctl
apply`) and probes `backend.url` directly — the same HTTP health
probe (`probeHealth` in `backends.ts`) it already does. Hot-reload
is supervisor-local: SIGHUP, `fs.watch`, or admin-only
`qwen_reload_backends` MCP tool.

- ✅ Cross-platform — tmux runs everywhere we care about
- ✅ Lifecycle and observation surface are one and the same — no
  duplicate "agent thinks it's running" / "tmux says it's not"
- ✅ Operator's `qwenctl attach` is the *real* runtime state, not a
  status mirror
- ✅ No daemon to compose with the supervisor; no "agent crashed"
  failure mode
- ⚠️ Tmux format-string parsing is shell-text. Mitigated by using
  `tmux -F '#{...}'` exclusively (a documented stable API), with
  unit tests pinning the expected format
- ⚠️ SSH ControlMaster + mosh required for low-latency operator
  flows; standard tooling, well documented

**Decision: Option D.** Tmux is the lifecycle and observation
surface. SSH (with ControlMaster persistence) is the transport.
mosh is the operator-attach transport for resilient long sessions.
No agent.

### Option E — Option D plus stateless HTTP→tmux agent (CONSIDERED, NOT NOW)

Same as Option D plus a small stateless `qwen-fleet-agent` on each
host exposing `GET /instances`, `POST /instances/<id>/start|stop`.
The agent shells out to tmux internally; tmux remains the source of
truth.

This was the previous draft's choice. It doesn't carry its weight:

- The supervisor never calls the agent — it reads a local file and
  probes URLs directly.
- `qwenctl` can SSH-exec tmux commands at well under 100 ms each
  (with ControlMaster), which is fine for an interactive operator
  tool. No HTTP daemon needed.
- The agent adds a cross-compile target, a deploy step, a
  supervision concern (what restarts the agent?), and a class of
  failure modes ("agent stale", "agent unreachable") that don't
  exist in Option D.

Where Option E would help: networks where SSH-exec is blocked but
HTTP through a known port is allowed (rare). If that scenario
materializes, this RDR's successor adds the agent as an alternate
transport without changing the operator-facing surface (`fleet.toml`,
`qwenctl` commands). The decision today is to not pre-build for it.

## Decision

A three-component system:

1. **`fleet.toml`** — declarative state on the operator's
   workstation.
2. **`qwenctl`** — operator CLI; reconciler. TypeScript on Node,
   shipped alongside the supervisor (same repo, same package, same
   `node_modules`). SSH-execs tmux commands on remote hosts; runs
   tmux directly for the local host. SSH / mosh / tmux are invoked
   as child processes, not via library bindings — we want the real
   `ssh` client for `ControlMaster`, `~/.ssh/config`, and arbitrary
   per-host `ssh_options` pass-through.
3. **Supervisor changes** — `fs.watch`/SIGHUP/`qwen_reload_backends`
   for backend hot-reload, plus drain semantics on backend removal.

Remote hosts run only their existing tooling: `tmux`, `mosh-server`,
`llama-server`. No supervisor-authored daemon on the remote.

`qwenctl` is TypeScript because the supervisor already is, on the
same machine. There's no cross-compile concern (qwenctl never runs
anywhere except the operator's workstation), no second deploy
target, and no need for a separate package manager. The supervisor's
type definitions for `Backend` and the fleet schema are imported
directly. Operators who already have Node installed for the
supervisor get qwenctl with the same `npm install`.

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

TypeScript on Node, distributed as a `bin` entry of the supervisor's
npm package. Commands:

| Command                              | Effect |
|--------------------------------------|--------|
| `qwenctl ps`                         | Fleet-wide table: id, host, port, state, uptime, model, KV-cache hit, mem |
| `qwenctl up [INST...]`               | Bring up instances (default: all not running). Idempotent. |
| `qwenctl down [INST...]`             | Stop instances. Sends SIGINT into the tmux window's pane; waits 5 s; kills window if still running. |
| `qwenctl restart [INST...]`          | down → up |
| `qwenctl logs INST [-f]`             | Stream the instance's log: SSH-exec'd `tmux capture-pane` snapshot for pre-flush content, then `tail -f` of the on-disk log |
| `qwenctl attach [HOST]`              | mosh + tmux attach to the host's `qwen-fleet` session |
| `qwenctl status`                     | Supervisor view: configured backends, health, in-flight sessions |
| `qwenctl apply [FILE]`               | Reconcile: apply fleet.toml. Default `~/.config/qwen-fleet/fleet.toml` |
| `qwenctl diff [FILE]`                | Show what `apply` would change (no execute) |
| `qwenctl bootstrap HOST`             | Check tmux + mosh-server + llama.cpp availability on HOST; create `~/.qwen-fleet/{logs,models}`; print suggested fleet.toml block |
| `qwenctl pull-model HOST FILE`       | rsync a model file from local to the host's `models_dir` |
| `qwenctl reload-supervisor`          | Tell `qwen-agent-server` to re-read backends |
| `qwenctl shell HOST`                 | mosh into HOST (no tmux) — quick escape hatch |
| `qwenctl tmux HOST [WINDOW]`         | Send a tmux command to the host's session — escape hatch for advanced ops |

Reconciliation algorithm (`qwenctl apply`):

```
1. Parse and validate fleet.toml.
2. For each host in fleet.toml:
   a. Open (or reuse) an SSH ControlMaster connection.
   b. Run `tmux list-windows -F '<format>'` in the qwen-fleet session;
      ensure the session exists, create empty if not.
   c. Diff (declared instances on this host) vs (running windows).
   d. For new instances: tmux new-window with the rendered llama-server
      command; wait for the llama-server's HTTP /health.
   e. For removed instances: drain check (see "Drain semantics") then
      tmux kill-window.
   f. For changed instances (port, model, context, etc.): kill-window
      then new-window in place.
3. Generate $XDG_CONFIG_HOME/qwen-agent-server/backends.json on the
   operator's workstation (the supervisor's read-only backend list).
4. Send the supervisor a reload (SIGHUP or MCP qwen_reload_backends);
   alternatively, the supervisor's optional fs.watch picks it up.
5. Print qwenctl ps for confirmation.
```

The reconcile is deterministic and idempotent — re-running `apply`
without changing `fleet.toml` is a no-op (tmux windows that already
exist with the right command are left alone).

### Remote-host operations — SSH-only, no daemon

`qwenctl` interacts with each remote exclusively through SSH. There
is no agent process on the remote.

Operations:

| Operation                  | Implementation                                                     |
|----------------------------|--------------------------------------------------------------------|
| List instances on host     | `ssh HOST 'tmux list-windows -t qwen-fleet -F "#{window_name} #{pane_pid} #{window_activity}"'` |
| Start instance             | `ssh HOST 'tmux new-window -t qwen-fleet -n <id> -- <llama-server cmd>'` |
| Stop instance              | `ssh HOST 'tmux send-keys -t qwen-fleet:<id> C-c; sleep 5; tmux kill-window -t qwen-fleet:<id>'` (graceful then hard) |
| Probe instance health      | `curl -sf http://HOST:PORT/health` from the operator workstation (the supervisor uses the same path) |
| Tail instance log          | `ssh HOST 'tail -f ~/.qwen-fleet/logs/<id>.log'` |
| Capture pane content       | `ssh HOST 'tmux capture-pane -t qwen-fleet:<id> -p -J -S -2000'` (used to surface pre-flush output if the on-disk log is buffered) |
| Per-instance config render | qwenctl renders the llama-server command-line on the workstation; SSH-exec runs it inside tmux |

SSH ControlMaster (`-o ControlMaster=auto -o ControlPersist=10m`) is
strongly recommended in `host.<name>.ssh_options` to amortize SSH
connection setup across many small commands. With ControlMaster, a
five-host `qwenctl ps` typically completes in under 200 ms.

Tmux output is parsed using `-F '#{...}'` format strings exclusively
— a documented stable tmux API. Unit tests in `qwenctl/internal/tmux`
pin the expected format strings against snapshots from supported tmux
versions; format drift in a future tmux is caught immediately rather
than silently producing wrong fleet state.

### Local-host operations — same shape, no SSH

For `host.<name>.transport = "local"` (the operator's own machine),
`qwenctl` runs the same tmux commands directly without SSH. The code
path is one branch around `ssh HOST` becoming `bash -c`. The local
host appears in `qwenctl ps` and `qwenctl attach` like any other.

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
[1/4] connecting to hal@strix.local …  ok (uname=Linux x86_64)
[2/4] checking tmux …  ok (3.4)
[3/4] checking mosh-server …  ok (1.4.0)
[4/4] creating ~/.qwen-fleet/{logs,models} …  ok

llama.cpp build: NOT FOUND at /usr/local/bin/llama-server
        Run scripts/setup-strix-halo.sh to build llama.cpp with Vulkan support,
        then re-run `qwenctl apply` to bring up declared instances.

Suggested fleet.toml additions (paste into your fleet.toml):

[host.strix]
transport   = "ssh"
ssh_target  = "hal@strix.local"
ssh_options = ["-o", "ControlMaster=auto", "-o", "ControlPersist=10m"]
arch        = "linux-x86_64"
inference   = "vulkan"
models_dir  = "/srv/qwen/models"
llama_bin   = "/usr/local/bin/llama-server"

[host.strix.attach]
transport   = "mosh"
```

Bootstrap is idempotent: it only checks preconditions and creates
directories. Nothing on the remote needs upgrading between
`qwenctl` releases — there's no agent binary to keep in sync.

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
| ControlMaster socket goes stale                    | Next `qwenctl` command silently re-establishes the connection. No state damaged. |
| llama-server crashes inside its tmux window        | Pane shows the crash. `qwenctl ps` reports the window has no live pane process → `crashed`. `qwenctl restart <id>` recreates. |
| Network partition between operator and remote      | Supervisor's health probe marks remote unhealthy → routes around. Sessions on that backend follow §S2 (error + last_known). `qwenctl ps` cannot SSH to the host; reports `unreachable` for that host's instances. |
| Operator forgets `qwenctl down` before laptop reboot | Remote llama-servers continue (tmux survives operator reboot). `qwenctl ps` reconciles on next run. |
| Remote host reboots                                | Tmux session lost; llama-servers gone. Next `qwenctl apply` re-creates. Supervisor health probe drains affected backends per §S2. |
| Conflict: a model file expected by `fleet.toml` doesn't exist on the host | `qwenctl apply` runs a per-instance pre-flight (`ssh HOST 'test -f <path>'`) and fails clearly with a `qwenctl pull-model` suggestion. |
| Two `qwenctl apply` invocations race               | Each holds an advisory lock on the operator-side `fleet.toml` for the duration of apply. Concurrent invocations on the same operator workstation serialize; ones from different workstations are out of scope (Q7). |

### Implementation map

`qwenctl` is added to the existing `mcp-bridges/qwen-agent-server/`
package. One package, one `package.json`, one `npm install` — the
supervisor and qwenctl share dependencies, types, and tooling.

```
mcp-bridges/qwen-agent-server/
  src/                            existing supervisor
    server.ts                    (modified) SIGHUP handler, qwen_reload_backends
    pool.ts                      (modified) drain semantics
    fleet-config.ts              (new) parse backends.json
    fleet-watch.ts               (new) optional fs.watch
  src-qwenctl/                    new — qwenctl CLI
    bin.ts                        entry point: argv parser, dispatch
    fleet.ts                      fleet.toml parser, validator, differ
    ssh.ts                        ssh / mosh exec via child_process
    tmux.ts                       tmux command builders + format-string parsers,
                                  snapshot-tested against supported tmux versions
    instance.ts                   llama-server command rendering
    supervisor.ts                 reload-supervisor (SIGHUP + MCP)
    host.ts                       ssh-exec vs local-exec branch
  package.json
    "bin": { "qwenctl": "dist/src-qwenctl/bin.js" }
```

`npm install -g .` (or the supervisor's setup script) symlinks
`qwenctl` onto the operator's `PATH`. No second toolchain joins the
project. Remote hosts still run nothing supervisor-authored; they
need only `tmux`, `mosh-server`, and `llama-server`.

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
- No supervisor-authored daemon on remote hosts. Remote
  prerequisites are just `tmux`, `mosh-server`, and `llama-server`
  — all standard, none authored here.
- Operators get a single-pane-of-glass dashboard per host without
  any custom UI code — tmux is the UI.
- The two control planes (runtime: supervisor; operator: qwenctl)
  remain cleanly separate. Failure in one doesn't propagate.
- One language for the project. `qwenctl` lives in the supervisor's
  npm package; no second toolchain, no cross-compile matrix, no
  separate dependency tree.

### Negative

- Tmux is now load-bearing on every remote. Hosts without tmux
  can't host instances. Bootstrap detects and reports; install
  guidance documented.
- Mosh is recommended, not required. Hosts without mosh lose
  laptop-roam — fallback to plain SSH attach. Operator picks.
- SSH-exec is the only remote mechanism. Networks where SSH-exec
  is blocked but a known HTTP port would be reachable are not
  supported today. If that scenario lands, a follow-up RDR adds
  Option E's agent as an alternate transport (the operator-facing
  surface in this RDR is unchanged by such a successor).
- Out-of-band changes (someone hand-launches a llama-server) are
  invisible to `qwenctl ps`. This is correct (declarative is the
  point) but operators must internalize "if it's not in fleet.toml,
  it doesn't exist to qwenctl."
- `qwenctl reload-supervisor` is a separate explicit step (or
  opt-in `fs.watch`). Keeps the supervisor from reacting to a
  half-edited file mid-apply.

### Neutral

- `fleet.toml` adds a config format; TOML chosen because it's
  human-editable and has stable parsers in both Node (`@iarna/toml`)
  and Python (stdlib `tomllib`). JSON would also work; YAML rejected
  (whitespace gotchas in operator-edited files).
- `~/.qwen-fleet/` directory layout introduces a per-host on-disk
  convention. Documented in bootstrap output.

## Research findings (open questions)

### Q1 — `qwenctl` implementation language

**Status:** Resolved — TypeScript on Node, in the same npm package
as the supervisor.

An earlier version of this RDR proposed Go, justified by
"cross-compile ergonomics" and "single-binary deploy." Both were
specious: `qwenctl` runs only on the operator's workstation (the
same machine as the supervisor), never on remote hosts. There is no
cross-compile concern and no second deploy target. The operator
already has Node installed for the supervisor; reusing it costs
nothing.

TypeScript advantages here:

- One language for the project. Adding Go would mean a second
  toolchain, a second test framework, a second dependency manager,
  and parallel type definitions for `Backend`/fleet schema.
- Direct import of supervisor types — `qwenctl` and the supervisor
  agree on `Backend`, `SpawnOpts`, etc. by sharing the source.
- SSH/mosh/tmux are invoked via `child_process.spawn` — no SSH
  library wanted in any language. The real `ssh` client is what we
  want; it honours `~/.ssh/config`, `ControlMaster`, and the
  per-host `ssh_options` pass-through. A Go SSH library would make
  these harder, not easier.
- TOML parsing via `@iarna/toml` (already lightweight, MIT, no
  native deps). Same library can be used by the supervisor for
  reading `backends.toml` if we ever migrate from JSON.

Node startup latency (~100 ms) is irrelevant — the dominant cost in
any qwenctl operation is the SSH round-trip (~50 ms with
ControlMaster, hundreds without). Single-file binary (`pkg`/`nexe`)
considered and rejected — the operator runs Node anyway, so plain
`node dist/src-qwenctl/bin.js` (with an `npm bin` symlink to
`qwenctl`) is the cleanest path.

### Q2 — tmux output parsing fragility

**Status:** Resolved — use `tmux list-windows -F '#{...}'` format
strings exclusively, never parse human-readable output.

`tmux` provides a stable format-string vocabulary. `qwenctl`'s
parser only consumes structured output. Unit tests in
`internal/tmux` snapshot the expected format strings against
supported tmux versions; format drift in a future tmux is a hard
test failure rather than silent fleet-state corruption.

### Q3 — Auth between qwenctl and remote hosts

**Status:** Resolved — SSH access. No additional auth.

Authentication is whatever `~/.ssh/config` and `host.<name>.ssh_options`
configure. No tokens, no certs, no daemons-with-auth. The operator
already has SSH access to hosts they want to manage; `qwenctl` uses
that. Matches D8 (minimal authority on remotes).

For local-host (`mac-local`), `qwenctl` runs commands directly
without SSH.

### Q4 — Live log streaming

**Status:** Resolved — hybrid: capture-pane snapshot + tail-on-disk.

`qwenctl logs <inst> -f` first captures the tmux pane's recent
history (`tmux capture-pane -p -J -S -2000`) so the operator sees
anything not yet flushed to disk, then tails the on-disk log
(`tail -f ~/.qwen-fleet/logs/<inst>.log`) for live output. Both
pieces are SSH-exec'd; the resulting stream is a clean union.

### Q5 — `tmux-resurrect` for survival across host reboot

**Status:** Resolved — NOT default-enabled.

Auto-resurrecting llama-servers on host reboot surprises operators
("why is the GPU at 100% — I didn't start anything") and may silently
load stale model paths after a model directory rename. Explicit
`qwenctl apply` post-reboot is the right semantic.

Operators who *want* persistence can install tmux-resurrect manually;
they're informed but on their own.

### Q6 — Concurrent `qwenctl apply` on the same operator workstation

**Status:** Resolved — file lock on the operator-side `fleet.toml`.

`qwenctl apply` acquires an advisory lock on `fleet.toml` for the
duration of the reconcile. Concurrent invocations on the same
workstation serialize. `qwenctl apply` is fast (typically seconds
for a small fleet), so the lock is rarely contended.

### Q7 — Multi-operator (different workstations sharing one remote fleet)

**Status:** Out of scope; revisit if the use case lands.

Two operators on different workstations both running `qwenctl
apply` against the same Strix Halo would conflict (no shared file
lock). The current design assumes one operator workstation is
canonical for any given remote host.

Mitigations if multi-operator lands:

- Per-host advisory file lock on `~/.qwen-fleet/.lock` (acquired
  via SSH-exec'd `flock`). Adds latency to every `apply` but makes
  multi-operator safe.
- Or: a designated "owner" operator workstation per host, others
  read-only.

Flag for RDR-005 if real.

### Q8 — Cross-host model storage

**Status:** Resolved — per-host `models_dir`. `qwenctl pull-model`
moves model files between hosts (rsync over SSH). No shared
filesystem assumed. Each host has its own copy.

For a fleet of 3-5 hosts and ~25 GB models, total disk cost is
acceptable. Operators with many hosts and many models can switch to
a shared NFS path manually — `models_dir` accepts any path.

### Q9 — When does Option E (HTTP agent) come back?

**Status:** Out of scope today; tracked.

Option E was rejected because (a) the supervisor doesn't need a
remote RPC surface — it reads a local file and probes URLs
directly — and (b) `qwenctl` can SSH-exec tmux commands at well
under 100 ms each.

Option E's agent would be the right tool if a real deployment
appears where SSH-exec is blocked but HTTP through a known port is
allowed. The operator-facing surface (`fleet.toml`, `qwenctl`
commands, tmux session layout) does not change in such a successor;
only the transport between `qwenctl` and the remote does. The
agent, if added, would shell out to the same tmux commands
`qwenctl` runs over SSH today — keeping tmux as the source of truth.

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
