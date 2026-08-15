#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# RDR-016 provenance guard: PreToolUse hook on Bash. Blocks command shapes
# that bypass scripts/ops/provenance/provenance.py — raw HF/GitHub/Ollama/LM
# Studio acquisition, unverified weight transfer to the box, and loading
# pickle-format model files (arbitrary code on load). The tool is the
# positive path; this is a deny-list on the command string, not a scanner —
# false positives are expected and tuned over time (RDR-016 Consequences).
#
# Contract (Claude Code PreToolUse hook): stdin is
#   {"tool_name": "...", "tool_input": {"command": "..."}, ...}
# To block, print a JSON permissionDecision to stdout and exit 0. To allow,
# print nothing and exit 0. We never use exit 2 here — the JSON form is the
# documented preference and keeps the reason machine-parseable.
#
# bash 3.2 compatible (macOS /bin/bash default): no mapfile, no ${var,,},
# no associative arrays. Word-boundary matching uses [^A-Za-z0-9_] classes
# instead of \b (not portable to BSD grep's ERE).

set -u

RAW_INPUT="$(cat)"

# Parse with python3 (present on the Mac, CLAUDE.md). On any parse failure,
# fail OPEN (allow) but say so on stderr — a hook that fails closed on
# malformed input would block unrelated tool calls it never should have seen.
# stderr is inherited (not captured) so a parse-failure message reaches the
# hook's own stderr directly, no temp file needed.
PARSED="$(printf '%s' "$RAW_INPUT" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception as exc:
    sys.stderr.write("provenance-guard: failed to parse hook input JSON: %s\n" % exc)
    sys.exit(1)
tool_name = data.get("tool_name", "") or ""
tool_input = data.get("tool_input", {})
command = ""
if isinstance(tool_input, dict):
    command = tool_input.get("command", "") or ""
sys.stdout.write(tool_name)
sys.stdout.write("\x1e")
sys.stdout.write(command)
')"
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
    exit 0
fi

TOOL_NAME="${PARSED%%$'\x1e'*}"
COMMAND="${PARSED#*$'\x1e'}"

if [ "$TOOL_NAME" != "Bash" ]; then
    exit 0
fi

if [ -z "$COMMAND" ]; then
    exit 0
fi

# Case-insensitive extended-regex match against $COMMAND.
match() {
    printf '%s' "$COMMAND" | grep -Eqi -- "$1"
}

# Case-sensitive fixed-string match against $COMMAND (env var names, etc).
matchF() {
    printf '%s' "$COMMAND" | grep -Fq -- "$1"
}

# Same-LINE match: true iff some single line of $COMMAND matches ALL given
# patterns. Compound commands (an scp of a .ps1 followed by a heredoc that merely
# mentions a .gguf) must not trip the transfer rule — the weight token has to be
# on the scp/rsync line itself.
matchLine() {
    printf '%s\n' "$COMMAND" | while IFS= read -r line; do
        ok=1
        for pat in "$@"; do
            printf '%s' "$line" | grep -Eqi -- "$pat" || { ok=0; break; }
        done
        [ "$ok" -eq 1 ] && exit 0
    done
}

PROVENANCE_FETCH='python3 scripts/ops/provenance/provenance.py fetch'
PROVENANCE_ADD_RUNTIME='python3 scripts/ops/provenance/provenance.py add-runtime'
PROVENANCE_VERIFY='python3 scripts/ops/provenance/provenance.py verify'
PROVENANCE_SKILL='/qwen-stack:provenance'

REASON=""

if match '(^|[^A-Za-z0-9_])hf[[:space:]]+download($|[^A-Za-z0-9_])'; then
    REASON="Raw 'hf download' bypasses provenance tracking (no content-hash check, no allowlist, no lineage). Use: $PROVENANCE_FETCH <repo> (or $PROVENANCE_SKILL fetch)."
elif match '(^|[^A-Za-z0-9_])huggingface-cli[[:space:]]+download($|[^A-Za-z0-9_])'; then
    REASON="Raw 'huggingface-cli download' bypasses provenance tracking. Use: $PROVENANCE_FETCH <repo> (or $PROVENANCE_SKILL fetch)."
elif match 'snapshot_download\(' \
    || match 'hf_hub_download\(' \
    || match 'from[[:space:]]+huggingface_hub[[:space:]]+import[[:space:]]+.*(snapshot_download|hf_hub_download|HfApi)' \
    || match 'huggingface_hub\.(snapshot_download|hf_hub_download)'; then
    # Covers direct calls, `from huggingface_hub import X as anything` (any
    # alias — the real name is still present in the import list), and
    # `import huggingface_hub` + dotted attribute access.
    REASON="Raw huggingface_hub usage (snapshot_download / hf_hub_download / HfApi — direct call, aliased import, or dotted attribute access) bypasses provenance tracking. Use: $PROVENANCE_FETCH <repo> (or $PROVENANCE_SKILL fetch)."
elif match '(git clone|git lfs)' && match 'huggingface\.co'; then
    REASON="Raw git clone/lfs of a Hugging Face repo bypasses provenance tracking (no hash verification, revision not pinned to a resolved sha). Use: $PROVENANCE_FETCH <repo> (or $PROVENANCE_SKILL fetch)."
elif match '(curl|wget|aria2c)' && match '(huggingface\.co|hf\.co)' && ! match '/api/'; then
    REASON="Raw curl/wget/aria2c against Hugging Face bypasses provenance tracking. Read-only /api/ metadata calls are fine; weight downloads are not. Use: $PROVENANCE_FETCH <repo> (or $PROVENANCE_SKILL fetch)."
elif match '(^|[^A-Za-z0-9_])ollama[[:space:]]+pull($|[^A-Za-z0-9_])'; then
    REASON="'ollama pull' bypasses provenance tracking. Use: $PROVENANCE_FETCH <repo> (or $PROVENANCE_SKILL fetch)."
elif match '(^|[^A-Za-z0-9_])ollama[[:space:]]+run($|[^A-Za-z0-9_])'; then
    REASON="'ollama run' can implicitly pull an unmanifested model, bypassing provenance tracking. Pull explicitly and verify first: $PROVENANCE_FETCH <repo> (or $PROVENANCE_SKILL fetch), then serve the verified artifact."
elif match '(^|[^A-Za-z0-9_])lms[[:space:]]+(get|pull)($|[^A-Za-z0-9_])'; then
    REASON="LM Studio CLI pull bypasses provenance tracking. Use: $PROVENANCE_FETCH <repo> (or $PROVENANCE_SKILL fetch)."
elif match 'gh[[:space:]]+release[[:space:]]+download' && match '(llama\.cpp|ggml)'; then
    REASON="Raw 'gh release download' of a llama.cpp/ggml asset bypasses provenance tracking. Use: $PROVENANCE_ADD_RUNTIME (or $PROVENANCE_SKILL add-runtime)."
elif match '(curl|wget)' && match 'github\.com/[^ ]*/releases/download/'; then
    REASON="Raw curl/wget of a GitHub release asset bypasses provenance tracking. Use: $PROVENANCE_ADD_RUNTIME (or $PROVENANCE_SKILL add-runtime)."
elif matchLine '(^|[^A-Za-z0-9_])(scp|rsync|sftp)($|[^A-Za-z0-9_])' '(\.gguf|\.safetensors|mmproj)' '(qwentescence|[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:)' && ! matchF 'PROVENANCE_TRANSFER=1'; then
    REASON="Transferring weights/runtime to the box outside the provenance tool. Verify first ($PROVENANCE_VERIFY), then transfer via $PROVENANCE_SKILL, which sets PROVENANCE_TRANSFER=1 for its own scp/rsync step."
elif match 'torch\.load\(' && ! matchF 'weights_only=True' && ! matchF 'weights_only = True'; then
    REASON="torch.load() without weights_only=True can execute arbitrary code on load (pickle). Use safetensors/gguf via $PROVENANCE_FETCH."
elif match '(--model|--mmproj|-m)[[:space:]]+[^[:space:]]*\.(bin|pt|pth|pkl|pickle|ckpt|h5)($|[^A-Za-z0-9_])'; then
    REASON="Pickle-format model file (.bin/.pt/.pth/.pkl/.pickle/.ckpt/.h5) executes code on load and is refused. Use safetensors/gguf via $PROVENANCE_FETCH."
elif match 'from_pretrained\([^)]*\.(bin|pt|pth|pkl|pickle|ckpt|h5)'; then
    REASON="Pickle-format model file (.bin/.pt/.pth/.pkl/.pickle/.ckpt/.h5) executes code on load and is refused. Use safetensors/gguf via $PROVENANCE_FETCH."
elif match 'trust_remote_code[[:space:]]*=[[:space:]]*True' || match '(^|[^A-Za-z0-9_-])--trust-remote-code($|[^A-Za-z0-9_-])'; then
    REASON="trust_remote_code permits arbitrary code execution at import and is refused by default. Use $PROVENANCE_FETCH --allow-remote-code only after allowlist review, with every such file recorded in the manifest."
fi

if [ -z "$REASON" ]; then
    exit 0
fi

# json-escape a static reason string (backslash, then double-quote).
json_escape() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

if matchF 'QWEN_PROVENANCE_ENFORCE=0'; then
    # Documented escape hatch: do NOT deny, ask the human to confirm instead.
    ESCAPED_REASON="$(json_escape "$REASON (QWEN_PROVENANCE_ENFORCE=0 is set — this is the documented escape hatch; confirm the bypass is intentional.)")"
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}\n' "$ESCAPED_REASON"
    exit 0
fi

ESCAPED_REASON="$(json_escape "$REASON")"
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$ESCAPED_REASON"
exit 0
