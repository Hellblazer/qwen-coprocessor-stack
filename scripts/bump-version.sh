#!/usr/bin/env bash
# bump-version.sh <x.y.z> — rewrite every version site in lock-step.
#
# Bead qwen-coprocessor-stack-0lw. There are FIVE version sites and hand-editing
# them is how SUPERVISOR_VERSION got missed during v0.11.9 (the parity test
# caught it, but only after a CI round-trip). This script makes the miss
# impossible: one command updates them all, then verifies.
#
#   1. mcp-bridges/qwen-agent-server/package.json  (+ package-lock.json)
#   2. mcp-bridges/qwen-agent-server/src/version.ts   SUPERVISOR_VERSION
#   3. .claude-plugin/marketplace.json   metadata.version + plugins[0].version
#   4. .claude-plugin/marketplace.json   plugins[0].source.ref  ("v<x.y.z>")
#   5. plugins/qwen-stack/.claude-plugin/plugin.json  version + npx pin
#
# It also stubs a CHANGELOG section under [Unreleased]. It does NOT commit, tag,
# or push — that stays human (open the release PR, merge, push the tag; the
# release.yml workflow publishes on the tag).
#
# Usage: scripts/bump-version.sh 0.12.0
set -euo pipefail

NEW="${1:-}"
if ! printf '%s' "$NEW" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "usage: $0 <x.y.z>   (semver, e.g. 0.12.0)" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/mcp-bridges/qwen-agent-server"
MARKET="$ROOT/.claude-plugin/marketplace.json"
PLUGIN="$ROOT/plugins/qwen-stack/.claude-plugin/plugin.json"
CHANGELOG="$ROOT/CHANGELOG.md"

OLD="$(node -p "require('$PKG/package.json').version")"
if [ "$OLD" = "$NEW" ]; then
  echo "version is already $NEW — nothing to do" >&2
  exit 0
fi
# Escape dots so they're literal in the perl regexes below.
OLD_RE="${OLD//./\\.}"
DATE="$(date +%F)"

echo "bumping $OLD -> $NEW"

# 1. package.json + package-lock.json (npm keeps both in sync)
( cd "$PKG" && npm version "$NEW" --no-git-tag-version >/dev/null )

# 2. SUPERVISOR_VERSION
perl -pi -e "s/SUPERVISOR_VERSION = \"$OLD_RE\"/SUPERVISOR_VERSION = \"$NEW\"/" "$PKG/src/version.ts"

# 3 + 4. marketplace.json: both "version" fields and the source.ref tag
perl -pi -e "s/\"version\": \"$OLD_RE\"/\"version\": \"$NEW\"/g; s/\"ref\": \"v$OLD_RE\"/\"ref\": \"v$NEW\"/" "$MARKET"

# 5. plugin.json: version field + the npx pin
perl -pi -e "s/\"version\": \"$OLD_RE\"/\"version\": \"$NEW\"/; s/qwen-agent-server\@$OLD_RE/qwen-agent-server\@$NEW/" "$PLUGIN"

# CHANGELOG stub under [Unreleased] (fill in the details before releasing).
perl -0pi -e "s/## \\[Unreleased\\]\n/## [Unreleased]\n\n## [$NEW] - $DATE\n\n_TODO: summarize this release._\n/" "$CHANGELOG"

# Verify: every site is NEW, no stray OLD remains in the version sites.
echo "--- verify ---"
fail=0
check() { grep -q "$2" "$1" || { echo "MISSING in $1: $2"; fail=1; }; }
check "$PKG/package.json"           "\"version\": \"$NEW\""
check "$PKG/src/version.ts"          "SUPERVISOR_VERSION = \"$NEW\""
check "$MARKET"                      "\"version\": \"$NEW\""
check "$MARKET"                      "\"ref\": \"v$NEW\""
check "$PLUGIN"                      "\"version\": \"$NEW\""
check "$PLUGIN"                      "qwen-agent-server@$NEW"
if grep -RnE "(\"v?$OLD_RE\")|qwen-agent-server@$OLD_RE" "$MARKET" "$PLUGIN" "$PKG/src/version.ts" 2>/dev/null; then
  echo "WARNING: stray old version $OLD still present above"; fail=1
fi
if [ "$fail" -eq 0 ]; then echo "all version sites -> $NEW"; else echo "bump INCOMPLETE"; exit 1; fi

cat <<EOF

Next (human):
  1. Fill in the CHANGELOG [$NEW] section.
  2. git checkout -b chore/release-v$NEW && git add -p && git commit -m "chore: release v$NEW"
  3. open PR -> merge to main
  4. git tag v$NEW <merge-commit> && git push origin v$NEW
     -> release.yml publishes qwen-agent-server@$NEW to npm (OIDC) + cuts the GitHub Release.
EOF
