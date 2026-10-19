#!/bin/bash
# Run one DeepSeek Harness (dsh) headless session on a task inside a git worktree, with
# DeepSeek served by OpenRouter pinned to one provider. Bead yudq.
#
# Usage: dsh-run.sh WORKTREE TASK_FILE [OUTDIR]
#   WORKTREE   a linked git worktree (the main checkout is refused); dsh's workspace-write
#              sandbox confines its writes to it
#   TASK_FILE  the task text
#   OUTDIR     where events.ndjson, usage.jsonl and summary.json go (default: a new temp dir);
#              must not be inside WORKTREE
# Env: DSH_MODEL (default deepseek/deepseek-v4.1-flash-1017), DSH_PROVIDER (default DeepInfra),
#      DSH_TIMEOUT seconds (default 1500), OPENROUTER_API_KEY (else Keychain item ds-openrouter).
# Stdout: one JSON line from dsh_summary.py (turns, is_error, usage with cost, result, outdir).
HERE=$(cd "$(dirname "$0")" && pwd -P) || exit 1
DSH="${DSH_BIN:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
WT=${1:?usage: dsh-run.sh WORKTREE TASK_FILE [OUTDIR]}; TASK=${2:?task file}
fail() { printf '{"is_error":true,"result":"%s"}\n' "$1"; exit 1; }
[ -x "$DSH" ] || fail "dsh not found at $DSH"
command -v timeout >/dev/null || fail "timeout (coreutils) not on PATH"
[ -r "$TASK" ] || fail "cannot read task file $TASK"
WT=$(cd "$WT" && pwd -P) || fail "no such worktree"
GD=$(git -C "$WT" rev-parse --absolute-git-dir 2>/dev/null) || fail "not a git worktree: $WT"
CD=$(cd "$WT" && cd "$(git rev-parse --git-common-dir)" && pwd -P)
[ "$GD" != "$CD" ] || fail "refusing the main checkout; pass a linked worktree"
OUT=${3:-$(mktemp -d -t dsh-run)}; mkdir -p "$OUT" || fail "cannot create $OUT"
OUT=$(cd "$OUT" && pwd -P)
case "$OUT/" in "$WT"/*) fail "OUTDIR is inside the worktree";; esac

K="${OPENROUTER_API_KEY:-}"
[ -n "$K" ] || K="$(security find-generic-password -s ds-openrouter -w 2>/dev/null)"
[ -n "$K" ] || fail "no OpenRouter key (env OPENROUTER_API_KEY or Keychain ds-openrouter)"

PP=""
cleanup() { [ -n "$PP" ] && kill "$PP" 2>/dev/null; }
trap cleanup EXIT
python3 "$HERE/dsh-pin-proxy.py" "$OUT/usage.jsonl" "$OUT/port" 2> "$OUT/proxy.stderr" &
PP=$!
for _ in $(seq 1 50); do [ -s "$OUT/port" ] && break; sleep 0.1; done
[ -s "$OUT/port" ] || fail "proxy did not start (see $OUT/proxy.stderr)"

cd "$WT" || exit 1
DSH_PROXY_BASE="http://127.0.0.1:$(cat "$OUT/port")" OPENROUTER_API_KEY="$K" \
  DSH_MODEL="${DSH_MODEL:-deepseek/deepseek-v4.1-flash-1017}" \
  timeout "${DSH_TIMEOUT:-1500}" "$DSH" --profile headless --patch "$HERE/dsh-openrouter.patch.yml" \
  --json - < "$TASK" > "$OUT/events.ndjson" 2> "$OUT/events.ndjson.stderr"
rc=$?
python3 "$HERE/dsh_summary.py" "$OUT/events.ndjson" "$OUT/usage.jsonl" "$rc" > "$OUT/summary.json"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d["outdir"]=sys.argv[2]; print(json.dumps(d))' \
  "$OUT/summary.json" "$OUT"
