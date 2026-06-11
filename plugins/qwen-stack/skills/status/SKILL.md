---
name: status
description: One-glance overview of qwen-stack — plugin version, supervisor process state, dist build freshness, configured backends with live health, config-file path, and any obvious red flags (stale binary, env override masking config, dead default backend). Use when the user types `/qwen-stack:status` or asks "is the qwen stack healthy" / "what's running" / "is everything wired up".
argument-hint: (no args)
allowed-tools: Bash, Read, mcp__plugin_qwen-stack_supervisor__qwen_backends, mcp__plugin_qwen-stack_supervisor__qwen_extensions, mcp__plugin_qwen-stack_supervisor__qwen_sessions
---

# /qwen-stack:status

Single-screen sanity check for the whole stack. Read-only — never writes anything. Designed so the operator can paste the output in a bug report or share with another collaborator.

## What to gather (in this order)

### 1. Plugin version + repo state

- Resolve the repo root: `pgrep -f qwen-agent-server/dist/server.js | head -1 | xargs -I{} ps -p {} -o args=` and back out the repo root from the `dist/server.js` path (strip the `mcp-bridges/qwen-agent-server/dist/server.js` suffix). If the supervisor isn't running, fall back to `git rev-parse --show-toplevel` from the user's current cwd (only useful when they're inside the repo).
- `cat <repo>/.claude-plugin/plugin.json` — read `name`, `version`.
- `git -C <repo> log -1 --format='%h %s (%cr)'` for the current commit.
- Optional: `git -C <repo> status --short | head -3` if dirty (note as "uncommitted local changes").

### 2. Supervisor process

- `pgrep -f qwen-agent-server/dist/server.js` — there should be exactly one PID.
- `ps -p <pid> -o pid,etime,rss,args` — capture start-elapsed time + working set.
- **Stale-binary check**: compare `dist/server.js` mtime to the supervisor process's start time. If the binary is newer than the running process, the operator did `npm run build` after CC started and the running supervisor is on stale code. Surface this loudly — it's the same gotcha we hit during 0.2 development.
  - Linux/macOS approach: `stat -f %m dist/server.js` (Mac) or `stat -c %Y` (Linux) for binary mtime. Process start: parse `ps -o lstart=` or compute from `etime`.
  - Threshold: if binary mtime is newer than process start by more than 60 s, flag it.

### 3. Backends + health

- Call the MCP tool `qwen_backends` (no args).
- Render a compact table with id / url / model / tier / capacity / healthy.
- ✓ for `true`, ✗ for `false`, `?` for `null` (unprobed).

### 4. Live sessions (RDR-002 v0.7)

- Call the MCP tool `qwen_sessions` (no args).
- If the result is empty, suppress this section entirely.
- Otherwise render a compact table per session:
  `task_id / backend_id / state / turns / est-tokens (% of cap) / tool-calls (% of cap)`.
- For the percent columns: when the cap is `0` (disabled / unlimited) show `—` instead of a percent, since `0` doesn't mean "100 % full." When the cap is non-zero, render `est_tokens / max_tokens` and the percent rounded to nearest integer.
- Sort rows by `last_polled_at` ascending so the staler ones bubble up — easy spotting of sessions a caller forgot to drain.

This section is the operator's window into the budget guardrail in action; it's also how a stalled session that the orchestrator has stopped polling becomes visible.

### 5. Config sources

- `echo "${QWEN_BACKENDS:-}"` — flag if non-empty (env override is masking the file).
- `~/.qwen-coprocessor-stack/config.json`:
  - if absent: note "absent (built-in default)".
  - if present: show path + size + last-modified.
- `echo "${QWEN_DEFAULT_EXTENSIONS:-}"`, `echo "${QWEN_ADMIN_TOOLS:-}"`, `echo "${QWEN_MAX_CONTEXT_TOKENS:-}"`, `echo "${QWEN_MAX_TOOL_CALLS:-}"` — operator-facing knobs worth surfacing. Show "(unset)" if not set.

### 6. Red flags

A separate "Notes" section listing anything noteworthy:

- Stale binary (see step 2).
- `QWEN_BACKENDS` env set — silently overrides the config file; operator might not realise.
- `QWEN_MAX_CONTEXT_TOKENS` / `QWEN_MAX_TOOL_CALLS` env set — silently overrides config.session_budget. Same surprise risk; the operator might be editing config.json without realising the env wins.
- Backend with `healthy: false` — supervisor can't reach it; spawns may fail.
- All backends `healthy: null` — never been probed; first spawn will be the cold-probe.
- A live session with `est_tokens` ≥ 75 % of `max_tokens` and `state=running` — caller probably hasn't reacted to the warn pressure event; flag it.
- A live session in `state=error` that hasn't been stopped (still in pool) — orchestrator forgot to call `qwen_stop`; minor but it's pool slots.
- Process working set > 5 GB — could be a leak; worth a glance.
- Stale `qwen-coprocessor` MCP registration in `claude mcp list` (the dead Python `server.py` from before the TypeScript rewrite). Probe with `claude mcp list 2>/dev/null | grep -i 'qwen' | grep -v 'plugin:'` — if anything matches, it's stale.

If no red flags, say "no red flags."

## Output shape (target)

```
qwen-coprocessor-stack
  Plugin:     0.2.0  (commit abc1234, "v0.2.0 ship: backend lifecycle ...", 3 hours ago)
  Supervisor: PID 12345, up 4h22m, RSS 142 MB
  Build:     dist/server.js — 4h25m old (synced; fresh build)

Backends (from ~/.qwen-coprocessor-stack/config.json)
  ✓ qwentescence  http://qwentescence:1234/v1   qwen3.6-35b-a3b   remote / heavy

Sessions
  q-438f5d14  qwentescence  running  turn 0  2.4K / 50K (5%)  3 / —
  q-117a916b  qwentescence  error    turn 0  9.4K / 1K  (940%)  3 / —

Config
  QWEN_BACKENDS:           (unset)
  QWEN_DEFAULT_EXTENSIONS: (unset)
  QWEN_MAX_CONTEXT_TOKENS: (unset)
  QWEN_MAX_TOOL_CALLS:     (unset)
  QWEN_ADMIN_TOOLS:        (unset)
  config.json:             192 B, modified 3h ago

Notes
  no red flags
```

## Output style rules

- Concise. Never wrap a line over ~100 chars.
- No emojis. Use ✓ / ✗ / `?` glyphs only inside the backends table.
- Suppress sections that are entirely empty rather than padding with "(none)".
- If the supervisor process isn't running at all, say that prominently and skip the rest of the gather (no MCP call possible). Suggest `/reload-plugins`.
- Suppress shell command output that doesn't add signal — synthesize, don't dump.
