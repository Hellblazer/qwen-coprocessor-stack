#!/usr/bin/env bash
# One-time login for the claude-shim's isolated Claude Code config dir.
#
# The shim runs `claude -p` subprocesses against an isolated HOME so they
# can't read or write the user's main ~/.claude.json. That isolated HOME
# needs its own OAuth state — which means logging in once.
#
# This script launches an interactive Claude Code session whose HOME is the
# isolated dir, with all gateway env vars stripped so the inner claude talks
# directly to api.anthropic.com (not through our LiteLLM proxy). Inside,
# run /login, complete the OAuth flow in your browser, then /quit.
#
# Re-run this whenever you need to refresh auth (token expired, account
# changed, etc.).
set -euo pipefail

CLAUDE_SHIM_HOME="${CLAUDE_SHIM_HOME:-/tmp/claude-shim-home}"
mkdir -p "$CLAUDE_SHIM_HOME"

cat <<EOF
=== claude-shim auth setup ===

Isolated HOME: $CLAUDE_SHIM_HOME

About to launch Claude Code interactively against that HOME. In the TUI:
  1. /login
  2. complete the OAuth flow in your browser
  3. /quit

The shim will then use whatever account you log in as for all
claude-escalation traffic. Your main ~/.claude.json is untouched.

EOF

read -r -p "Press Enter to launch, or Ctrl-C to abort... "

# Strip every env var that would route the inner claude back through our
# gateway — we want it talking to api.anthropic.com directly during auth.
exec env -u ANTHROPIC_BASE_URL \
       -u ANTHROPIC_AUTH_TOKEN \
       -u ANTHROPIC_API_KEY \
       -u ANTHROPIC_MODEL \
       -u ANTHROPIC_SMALL_FAST_MODEL \
       -u ANTHROPIC_CUSTOM_HEADERS \
       HOME="$CLAUDE_SHIM_HOME" \
       claude
