---
name: dispatch
description: Open this session's qwen-stack settings page so the user can opt the session in to `qwen_dispatch`, pick its provider backend(s) and its default extension loadout. Use when the user types `/qwen-stack:dispatch`, or when `qwen_dispatch` returned `dispatch_not_enabled` and the user wants it on.
argument-hint: (no args)
allowed-tools: Bash, mcp__plugin_qwen-stack_supervisor__qwen_settings
---

# /qwen-stack:dispatch

`qwen_dispatch` is opt-in per session, and only the user may opt in. The opt-in lives on a small settings page served by this session's supervisor on 127.0.0.1. You open it for the user; they flip the switch.

## Steps

1. Call the MCP tool `qwen_settings` (no arguments). It is read-only and returns `{ url, state }`. The URL carries an access token that is valid until the supervisor restarts.
2. Run `open "<url>"` (macOS) so the page opens in the user's browser. On Linux use `xdg-open "<url>"`. Quote the URL.
3. Tell the user what the page controls, in a few lines:
   - dispatch on / off for this session (or "use the launch environment");
   - which backends dispatch may run on (each ticked backend becomes a pinned provider);
   - the default extension loadout, and live backend health;
   - everything applies to this session only, is held in memory, and is lost when the supervisor restarts. Nothing is written to `config.json`.
4. Summarise `state` briefly: whether dispatch is currently on and where that came from (`enabledSource`), the current providers, and any backend that is unhealthy.

## Rules

- Do NOT fetch the URL, POST to it, or script a browser against it. Enabling dispatch is the user's decision, made on the page. If they say they have saved, call `qwen_settings` again and read `state` to confirm.
- Do not print the URL into shared logs or files; it contains the token. Showing it in the chat once is fine if `open` fails.
- If `open` fails, give the user the URL and stop.
- There is no tool or argument that changes these settings. Do not look for one.
