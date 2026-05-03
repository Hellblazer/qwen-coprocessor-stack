# Source before running `claude` to route Claude Code through the local stack.
#   source ./claude-code/env.sh
#   claude
#
# After this, Claude Code talks to LiteLLM at :4000, which routes to:
#   - claude-qwen-coding   (M4 Max, default for everything that isn't escalated)
#   - claude-qwen-remote   (Strix Halo, when reachable)
#   - claude-escalation    (Anthropic Claude Sonnet, when ANTHROPIC_API_KEY is set)
# via the heuristic in config/router.py.
#
# Pin a specific route from the Claude Code TUI with /model — discovered routes
# appear there because Claude Code v2.1.126+ scans /v1/models at startup.

_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$_root/.env" ] || { echo "[!] $_root/.env missing. Copy .env.example and fill in." >&2; return 1 2>/dev/null || exit 1; }

set -a
# shellcheck disable=SC1090
. "$_root/.env"
set +a

export ANTHROPIC_BASE_URL="http://localhost:4000"
export ANTHROPIC_AUTH_TOKEN="$LITELLM_MASTER_KEY"

# Default request target. Anything routed through this name passes through the
# pre-call hook in router.py and lands on whichever backend the heuristic picks.
export ANTHROPIC_MODEL="claude-router-auto"
export ANTHROPIC_SMALL_FAST_MODEL="claude-qwen-coding"

# Avoid Claude Code presenting an x-api-key for a non-Anthropic backend.
unset ANTHROPIC_API_KEY

echo "[+] Claude Code routed -> $ANTHROPIC_BASE_URL  (model: $ANTHROPIC_MODEL)"
unset _root
