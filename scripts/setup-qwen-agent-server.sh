#!/usr/bin/env bash
# Setup script for qwen-agent-server MCP bridge.
#
# Idempotent: safe to run on a fresh checkout or repeatedly after updates.
# Steps:
#   1. Install npm dependencies
#   2. Build TypeScript → dist/
#   3. Install any framework-required extensions (currently a no-op
#      placeholder — extensions/ is empty by design per RDR-002; operator
#      extensions go to ~/.qwen/extensions/ and are managed via 'qwenctl
#      extensions ...', not this script)
#   4. Print the 'claude mcp add' registration command for the user to run manually
#
# Environment variables:
#   QWEN_AGENT_SERVER_HOME  — override the Qwen home dir
#                             (default: ~/.qwen-agent-server-home)

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$REPO/mcp-bridges/qwen-agent-server"
EXTENSIONS_DIR="$REPO/extensions"
QWEN_HOME="${QWEN_AGENT_SERVER_HOME:-$HOME/.qwen-agent-server-home}"

echo "==> qwen-agent-server setup"
echo "    repo:        $REPO"
echo "    server:      $SERVER_DIR"
echo "    qwen home:   $QWEN_HOME"
echo ""

# ── Step 1: npm install ──────────────────────────────────────────────────────
echo "==> npm install"
cd "$SERVER_DIR"
npm install
echo ""

# ── Step 2: build ────────────────────────────────────────────────────────────
echo "==> npm run build"
npm run build
echo ""

# ── Step 3: install framework-required extensions ───────────────────────────
# Create the Qwen home directory if it doesn't exist.
mkdir -p "$QWEN_HOME"

echo "==> installing framework extensions from $EXTENSIONS_DIR"

# extensions/ holds framework-required Qwen Code extensions (none today per
# RDR-002). Operator extensions live at ~/.qwen/extensions/ and are managed
# via 'qwenctl extensions ...' — this script does not touch them.
ext_count=0
while IFS= read -r -d '' f; do
  basename_f="$(basename "$f")"
  case "$basename_f" in
    README.md|.keep|.gitkeep) ;;
    *)
      ext_count=$((ext_count + 1))
      echo "    copying: $basename_f"
      cp -r "$f" "$HOME/.qwen/extensions/"
      ;;
  esac
done < <(find "$EXTENSIONS_DIR" -maxdepth 1 -mindepth 1 -print0 2>/dev/null || true)

if [ "$ext_count" -eq 0 ]; then
  echo "    (none to install — extensions/ is empty by design; see RDR-002)"
fi
echo ""

# ── Step 4: print registration command ──────────────────────────────────────
DIST_SERVER="$REPO/mcp-bridges/qwen-agent-server/dist/server.js"

echo "==> Registration command (run this manually to register with Claude Code):"
echo ""
echo "    claude mcp add --scope user qwen-agent-server \\"
echo "      \"node $DIST_SERVER\""
echo ""
echo "    Or with custom backends:"
echo "    QWEN_BACKENDS='[{\"id\":\"local\",\"url\":\"http://localhost:8080/v1\",\"model\":\"qwen3.6-27b-instruct\",\"tier\":\"local\",\"capacity\":\"heavy\"}]' \\"
echo "      claude mcp add --scope user qwen-agent-server \\"
echo "      \"node $DIST_SERVER\""
echo ""
echo "==> Setup complete."
