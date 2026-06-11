---
name: budget
description: Manage the qwen-stack supervisor's session-budget caps (`max_context_tokens` and `max_tool_calls`) — show current resolved values with source priority, set one or both fields in the config file, or clear them back to env / hardcoded defaults. Operates on the `session_budget` field in `~/.qwen-coprocessor-stack/config.json` and hot-reloads in the running supervisor without restart. Use when the user types `/qwen-stack:budget ...`.
argument-hint: list | set [--max-context-tokens N] [--max-tool-calls M] | clear [max-context-tokens | max-tool-calls]
allowed-tools: Bash, Read, Write
---

# /qwen-stack:budget

Lifecycle and inspection for the supervisor's per-session budget caps (RDR-002 §Session budget, 2026-05-09 amendment). The two caps abort a runaway session cleanly with `state=error` `code=context_exceeded` instead of crashing at the HTTP layer when the inner Qwen accumulates too much tool_result content or fires too many tool calls.

## Caps

- **`max_context_tokens`** — hard cap on the `chars / 4` token estimate over accumulated tool_result content. Default: `111000` (≈85 % of qwentescence's `--ctx-size 131072`). Set to `0` to disable.
- **`max_tool_calls`** — hard cap on tool_call count per session. Default: `0` (unlimited). Set explicitly to `0` to disable.

Pre-abort, a `context_pressure` event fires once each at 50 / 75 / 90 % of `max_context_tokens` so long-running pollers can wind down gracefully.

## Resolution priority (read by the supervisor on each spawn)

1. Per-spawn `opts.max_context_tokens` / `opts.max_tool_calls` — the orchestrator can override per call. Out of scope for this skill.
2. `QWEN_MAX_CONTEXT_TOKENS` / `QWEN_MAX_TOOL_CALLS` env vars (non-negative integers; invalid values warn-and-skip in the supervisor and fall through to the next tier).
3. `~/.qwen-coprocessor-stack/config.json` `session_budget: { max_context_tokens, max_tool_calls }` — the file you read/write here.
4. Hardcoded defaults: `111000` / `0`.

A value of `0` at any tier means "no cap" and is preserved as-is — i.e. `session_budget.max_context_tokens: 0` honours the operator's choice to disable the guardrail rather than silently substituting the default. This is operator-chooses semantics — the framework provides infrastructure, the operator decides the policy.

## Subcommand routing

Parse the first positional arg as the subcommand. If absent or `list`, run **list**. Otherwise dispatch on `set` or `clear`.

### list (default when no args)

For each cap (`max_context_tokens`, `max_tool_calls`) report:

1. **Resolved value** — what the supervisor would apply right now to a spawn that doesn't set the field.
2. **Source label** — one of `(QWEN_MAX_CONTEXT_TOKENS env)`, `(QWEN_MAX_TOOL_CALLS env)`, `(config.json)`, or `(hardcoded default)`.
3. If both env and config.json are populated, also note `"config.json has N; env overrides"`.

Steps:

1. Probe envs:
   ```bash
   echo "${QWEN_MAX_CONTEXT_TOKENS:-}"
   echo "${QWEN_MAX_TOOL_CALLS:-}"
   ```
   Treat empty / non-numeric / negative as unset (matches the supervisor's `parseNumericEnv` behaviour — invalid env values warn-and-skip).
2. Read `~/.qwen-coprocessor-stack/config.json` if present. Look for `session_budget.max_context_tokens` and `session_budget.max_tool_calls` (each is independently optional).
3. Apply the priority chain to compute the resolved value per cap.
4. Render two lines, one per cap, plus the source label. Example:

   ```
   max_context_tokens: 111000  (hardcoded default)
   max_tool_calls:     0       (config.json)         -> unlimited
   ```

   Annotate `0` for `max_context_tokens` as `disabled` and `0` for `max_tool_calls` as `unlimited` so the operator doesn't have to remember which knob means what when zero.

### set [--max-context-tokens N] [--max-tool-calls M]

Args:

- `--max-context-tokens N` — non-negative integer. `0` = disable cap.
- `--max-tool-calls M` — non-negative integer. `0` = unlimited.
- At least one flag must be supplied. Both may be supplied in one call.

Steps:

1. **Refuse to set a field whose env override is active.** If `--max-context-tokens N` is supplied AND `QWEN_MAX_CONTEXT_TOKENS` is set in the user's shell, abort that field with: "QWEN_MAX_CONTEXT_TOKENS is set in your shell; the env will silently override config.json. Either `unset QWEN_MAX_CONTEXT_TOKENS` or edit it directly in your shell rc." Same for `--max-tool-calls`. If only one of two requested fields is blocked, surface both outcomes in one response — don't half-write.
2. Validate each supplied value is a non-negative integer (no decimals, no negatives, no `0x...`). Reject with a one-line error otherwise.
3. Optional sanity nudge — not a hard reject:
   - For `--max-context-tokens`, warn (don't refuse) if `N > 200000` or `0 < N < 4000`. The first is bigger than any common llama.cpp ctx_size; the second leaves no headroom for a meaningful turn. Show the warning, but proceed with the write.
4. Read `~/.qwen-coprocessor-stack/config.json` (treat as `{}` if missing). Validate JSON shape.
5. Get-or-create the `session_budget` object. Set the supplied field(s); leave any unspecified field alone (i.e. don't clobber a previously-set `max_tool_calls` when the operator only updates `max_context_tokens`).
6. Preserve all other top-level fields (`backends`, `default_extensions`).
7. `mkdir -p ~/.qwen-coprocessor-stack`, write back with 2-space indent.
8. Confirm: print the new resolved values as `list` would, plus a one-liner about drain semantics: "applies to new spawns; running sessions keep the budget captured at their construction (RDR-002 §Session budget drain semantics)".

No supervisor reload tool needed — `getSessionBudgetDefaults()` mtime-caches the config file, so the next `qwen_spawn` re-reads automatically.

### clear [max-context-tokens | max-tool-calls]

Without an argument, removes the entire `session_budget` object. With an argument, removes just the named field and leaves the other intact (deletes the `session_budget` key entirely if both fields would be gone).

Steps:

1. **Refuse if the relevant env override is set.** Same rule as `set`: clearing the file value is meaningless when the env wins. Tell the user to unset the env variable instead.
2. Read `~/.qwen-coprocessor-stack/config.json`. If `session_budget` is absent (or the named field within it is absent), say "already unset" and stop.
3. Mutate the config:
   - No arg: `delete cfg.session_budget` entirely.
   - `max-context-tokens`: `delete cfg.session_budget.max_context_tokens`. If the object now has no own keys, delete the whole `session_budget` object too.
   - `max-tool-calls`: same shape, opposite field.
4. Preserve other fields, write back.
5. Confirm: "session_budget cleared; defaults apply (`max_context_tokens=111000`, `max_tool_calls=0`)" — or list the remaining field if a partial clear left one in place.

## Error handling

- File-write failure (permissions, disk full): show the underlying error, do not partially update.
- Invalid JSON in existing config.json: do not overwrite. Show the parse error and the offending content (first 200 chars). Suggest the user inspect manually.
- Non-integer or negative argument to `set`: refuse with a one-liner pointing at the offending flag.
- `clear` with an unknown field name (not `max-context-tokens` or `max-tool-calls`): refuse with the valid choices listed.

## Output style

- One-line confirmations for `set` and `clear`.
- For `list`: 2 lines for the resolved values, plus an optional override-note line if env is masking config. No more.
- Surface the file path on every write so the operator knows where state lives.
- No emojis.
- Don't dump shell command output verbatim; synthesize.
