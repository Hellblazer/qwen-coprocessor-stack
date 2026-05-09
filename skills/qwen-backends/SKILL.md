---
name: qwen-backends
description: Manage the qwen-coprocessor-stack supervisor's backend list — list configured backends with live health, add a new backend, remove one, or test connectivity. Operates on `~/.qwen-coprocessor-stack/config.json` and hot-reloads in the running supervisor without restart. Use when the user types `/qwen-backends ...`.
argument-hint: list | add <id> <url> [model] [tier] [capacity] [weight] | remove <id> | test [id]
allowed-tools: Bash, Read, Write, mcp__plugin_qwen-coprocessor-stack_qwen-agent-server__qwen_backends
---

# /qwen-backends

Lifecycle and discovery for the supervisor's backend list. Edits to `~/.qwen-coprocessor-stack/config.json` hot-apply on the next `qwen_spawn` or `qwen_backends` call — no supervisor restart required. Existing sessions stay pinned to their backend (RDR-001 §Q3).

## Resolution priority (read by the supervisor)

1. `QWEN_BACKENDS` env var — if set, **overrides** the config file. If the user has this set in their shell, prefer editing the shell rc instead of the file (and tell them so).
2. `~/.qwen-coprocessor-stack/config.json` `{ "backends": [...] }` — the file you read/write here.
3. Built-in single-local default (`local-27b` at `localhost:8080/v1`) when neither is set.

## Backend object shape

```json
{
  "id":       "qwentescence",                  // unique handle, kebab-case
  "url":      "http://qwentescence:1234/v1",   // OpenAI-compatible base
  "model":    "qwen3.6-35b-a3b",               // identifier returned by /v1/models
  "tier":     "remote",                        // "local" | "remote"
  "capacity": "heavy",                         // "fast" | "heavy"
  "weight":   1                                // optional, default 1
}
```

## Subcommand routing

Parse the first positional arg as the subcommand. If absent or `list`, run **list**. Otherwise dispatch on `add`, `remove`, or `test`.

### list (default when no args)

1. Call the MCP tool `qwen_backends` (no args). The supervisor returns each backend with a live `healthy` field (`true`/`false`/`null`).
2. Render a compact table: `id`, `url`, `model`, `tier`, `capacity`, `healthy`. Use ✓ / ✗ / ? glyphs for healthy true/false/null.
3. Note the count and where the supervisor read the list from. Detect this by checking:
   - If `QWEN_BACKENDS` env var is set in the user's shell (`echo $QWEN_BACKENDS`), say "(from QWEN_BACKENDS env)".
   - Else if `~/.qwen-coprocessor-stack/config.json` exists, say "(from ~/.qwen-coprocessor-stack/config.json)".
   - Else "(built-in default — file not present, env not set)".

### add <id> <url> [model] [tier] [capacity] [weight]

Args:
- `<id>` (required) — kebab-case unique handle.
- `<url>` (required) — OpenAI-compatible base ending in `/v1` (warn if missing).
- `[model]` — defaults to the value `/v1/models` returns from the URL. If absent, do a quick `curl -sf -m 5 <url>/models` to discover, falling back to `qwen3.6-35b-a3b` with a note.
- `[tier]` — `local` or `remote`. Default: `remote` if URL host is not `localhost`/`127.0.0.1`, else `local`.
- `[capacity]` — `fast` or `heavy`. Default: `heavy` for remote, `fast` for local.
- `[weight]` — integer ≥ 1. Default: `1`.

Steps:
1. **Refuse if `QWEN_BACKENDS` env is set** — it would silently override the file edit. Tell the user to either `unset QWEN_BACKENDS` in their shell or edit the env directly.
2. Probe `<url>/health` and `<url>/v1/models` (whichever responds) with `curl -sf -m 5`. If both fail, ask the user whether to add anyway. If they confirm, proceed.
3. Read `~/.qwen-coprocessor-stack/config.json` (if it doesn't exist, treat as `{ "backends": [] }`). Validate JSON shape.
4. Reject if `<id>` already exists in the list (case-insensitive). Tell the user to remove the old one first.
5. Append the new backend object with the resolved defaults filled in.
6. `mkdir -p ~/.qwen-coprocessor-stack` then write the JSON back with 2-space indent.
7. Confirm the write happened. Then call `qwen_backends` MCP tool to verify the supervisor's hot-reload picked it up — the new entry should appear with a `healthy` value.

### remove <id>

1. **Refuse if `QWEN_BACKENDS` env is set** — same reasoning as `add`.
2. Read the config file. Find the entry by `id` (case-insensitive). If not found, list the current ids and stop.
3. Write the filtered config back.
4. Verify via `qwen_backends` that the entry is gone.

### test [id]

1. Call `qwen_backends` MCP tool.
2. If `[id]` provided, filter to that one. If not found, list available ids.
3. For each shown backend, also do a direct `curl -sf -m 5 <url>/health` (or `<url>/v1/models` if `/health` 404s) to confirm the supervisor's cached health matches reality. Report any divergence.

## Error handling

- File-write failure (permissions, disk full): show the underlying error, do not partially update.
- Invalid JSON in existing config file: do not overwrite. Show the parse error and the offending content (first 200 chars). Suggest the user inspect manually.
- The supervisor's hot-reload re-reads on the next `qwen_spawn` or `qwen_backends` call. If a confirmation `qwen_backends` call shows stale data, mention that running sessions are still using the old list (expected — RDR-001 §Q3) but new spawns will see the updated list.

## Output style

- Concise. Tables for list/test; one-line confirmations for add/remove.
- Surface the file path edited so the user knows where state lives.
- No emojis unless the user already uses them.
- No "I will now…" preamble.
