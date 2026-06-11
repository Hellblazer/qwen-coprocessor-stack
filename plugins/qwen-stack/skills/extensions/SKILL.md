---
name: extensions
description: List installed Qwen Code extensions on the supervisor host with version, source, enabled state per scope, and declared commands/skills/agents/MCP servers. Read-only listing for v0.3 — install / remove / enable / disable are deferred to v0.4. Use when the user types `/qwen-stack:extensions` or asks "what qwen extensions are installed" / "what does extension X provide".
argument-hint: list | info <name>
allowed-tools: Bash, mcp__plugin_qwen-stack_supervisor__qwen_extensions
---

# /qwen-stack:extensions

Discovery for the supervisor's extension surface. v0.3 is **read-only** — install / remove / enable / disable shell out via `qwen extensions ...` and ship in v0.4.

## Architectural reminder

Extensions live on the **supervisor host** — the Mac running Claude Code, not the inference backend (e.g., `qwentescence`). The `qwen` CLI runs as a subprocess of the supervisor, so its extension state is local to wherever the supervisor lives. Don't reach across SSH for any of this.

## Subcommand routing

Parse the first positional arg as the subcommand. If absent or `list`, run **list**. Otherwise dispatch on `info`.

### list (default when no args)

1. Call the MCP tool `qwen_extensions` (no args). Returns an array of `ExtensionInfo` objects: `{name, version, source, path, enabled_user, enabled_workspace, commands, skills, agents, mcp_servers, context_files}`. Fields not present in the upstream output are omitted from the object.
2. Render a compact table: `name`, `version`, `enabled (U/W)`, `source`, `declares` (count summary like `2 cmds, 1 skill`).
3. Use ✓ / ✗ for the enabled-user and enabled-workspace columns, separated by a slash (`✓/✓`, `✓/✗`, etc.). Use `?` if the field is undefined.
4. If the list is empty, say "No extensions installed on the supervisor host." and suggest `qwen extensions install <source>` (the manual path until v0.4).
5. Footer line: count + path of the supervisor's extensions dir if known (typically `~/.qwen/extensions/`). The MCP response carries `path` per-extension; show the dirname of any entry as a hint.

### info <name>

1. Call `qwen_extensions`. Filter for the given name (case-insensitive). If not found, list available names and stop.
2. Render the full record as a compact key-value block. Show all populated fields in this order: `version`, `source`, `path`, `enabled (User)`, `enabled (Workspace)`, `commands`, `skills`, `agents`, `mcp_servers`, `context_files`.
3. List-typed fields (commands, skills, agents, mcp_servers, context_files) render as inline arrays for ≤4 items, indented multi-line for more.

## Error handling

- `qwen_extensions` returns `[]` if the supervisor's `pool.qwenRealBin` is unset (rare — happens only in test-shaped pools without infra wiring) or if the shell-out to `qwen extensions list` fails. Don't treat empty as an error — say "no extensions reported (or qwen binary unreachable)".
- On `info <name>` miss, do not retry with substring matching. Be strict; the operator can reread the list to find the exact name.

## Output style

- Tables for `list`; key-value block for `info`.
- No emojis outside the enabled-state glyphs.
- Suppress fields that are undefined or empty arrays.
- When an extension has zero declared `commands` AND zero `skills` AND zero `agents` AND zero `mcp_servers`, render "(declares nothing exposable)" rather than four empty zeros — unusual case but worth noting clearly.
