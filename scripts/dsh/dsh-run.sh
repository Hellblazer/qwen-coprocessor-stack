#!/bin/bash
# Run one DeepSeek Harness (dsh) headless session on a task inside a git worktree, with
# DeepSeek served by OpenRouter pinned to one provider. Bead yudq.
#
# Usage: dsh-run.sh WORKTREE TASK_FILE [OUTDIR]
#   WORKTREE   the root of a linked git worktree (the main checkout is refused). dsh runs in
#              workspace-write mode: its writes go only to the worktree, /tmp and a private
#              temp dir; reads and network are not restricted
#   TASK_FILE  the task text
#   OUTDIR     where events.ndjson, usage.jsonl and summary.json go (default: a new dir under
#              ~/.cache/dsh-run); must not be inside WORKTREE, /tmp or a temp dir, all of which
#              the session can write; files from an earlier run there are replaced
# Env: DSH_MODEL (default deepseek/deepseek-v4.1-flash-1017), DSH_PROVIDER (default DeepInfra),
#      DSH_TIMEOUT seconds (default 1500), OPENROUTER_API_KEY (else Keychain item ds-openrouter).
#      Only the proxy gets the key; dsh and its tools see a dummy.
# Stdout: one JSON line (turns, is_error, rc, usage with cost, result, outdir).
# Exit status: 0 when is_error is false, 1 otherwise.
HERE=$(cd "$(dirname "$0")" && pwd -P) || exit 1
DSH="${DSH_BIN:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
OUT=""
fail() {
  python3 -c 'import json,sys; print(json.dumps({"turns": 0, "is_error": True, "rc": -1, "turn_end": [],
    "usage": {}, "result": sys.argv[1], "outdir": sys.argv[2] or None}))' "$1" "$OUT"
  exit 1
}
[ $# -ge 2 ] || fail "usage: dsh-run.sh WORKTREE TASK_FILE [OUTDIR]"
WT=$1; TASK=$2
[ -x "$DSH" ] || fail "dsh not found at $DSH"
command -v timeout >/dev/null || fail "timeout (coreutils) not on PATH"
[ -r "$TASK" ] || fail "cannot read task file $TASK"
TASK="$(cd "$(dirname "$TASK")" && pwd -P)/$(basename "$TASK")"
WT=$(cd "$WT" 2>/dev/null && pwd -P) || fail "no such worktree: $1"
TOP=$(git -C "$WT" rev-parse --show-toplevel 2>/dev/null) || fail "not a git worktree: $WT"
TOP=$(cd "$TOP" && pwd -P) || fail "cannot resolve worktree root"
[ "$TOP" = "$WT" ] || fail "WORKTREE must be the worktree root ($TOP)"
GD=$(git -C "$WT" rev-parse --absolute-git-dir 2>/dev/null) || fail "cannot read git dir of $WT"
CD=$(cd "$WT" && cd "$(git rev-parse --git-common-dir)" && pwd -P) || fail "cannot read git common dir of $WT"
GD=$(cd "$GD" && pwd -P) || fail "cannot resolve git dir"
[ -n "$CD" ] && [ "$GD" != "$CD" ] || fail "refusing the main checkout; pass a linked worktree"
if [ -n "$3" ]; then
  # realpath of a path that does not exist yet resolves its existing ancestors, so this is
  # checked before mkdir creates anything.
  case "$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$3")/" in
    "$WT"/*) fail "OUTDIR is inside the worktree";;
  esac
  mkdir -p "$3" || fail "cannot create $3"
  OUT=$(cd "$3" && pwd -P) || fail "cannot resolve $3"
else
  mkdir -p "$HOME/.cache/dsh-run" && OUT=$(mktemp -d "$HOME/.cache/dsh-run/run.XXXXXX") || fail "cannot create a run dir"
  OUT=$(cd "$OUT" && pwd -P)
fi
case "$OUT/" in
  "$WT"/*) fail "OUTDIR is inside the worktree";;
  /private/tmp/*|/tmp/*|/private/var/folders/*|/var/folders/*) fail "OUTDIR is in a temp dir the session can write";;
esac
rm -f "$OUT/port" "$OUT/usage.jsonl" "$OUT/events.ndjson" "$OUT/events.ndjson.stderr" "$OUT/summary.json"

K="${OPENROUTER_API_KEY:-}"
[ -n "$K" ] || K="$(security find-generic-password -s ds-openrouter -w 2>/dev/null)"
[ -n "$K" ] || fail "no OpenRouter key (env OPENROUTER_API_KEY or Keychain ds-openrouter)"

PP=""; DP=""; DTMP=""
# timeout (coreutils) puts itself and dsh in a new process group whose id is its pid, so
# killing that group also takes the background jobs dsh started.
kill_dsh() {
  [ -n "$DP" ] || return 0
  kill -TERM -- "-$DP" 2>/dev/null && sleep 1
  kill -KILL -- "-$DP" 2>/dev/null
  DP=""
}
cleanup() { kill_dsh; [ -n "$PP" ] && kill "$PP" 2>/dev/null; [ -n "$DTMP" ] && rm -rf "$DTMP"; }
trap cleanup EXIT
MODEL="${DSH_MODEL:-deepseek/deepseek-v4.1-flash-1017}"
printf '%s\n' "$K" | env -u OPENROUTER_API_KEY DSH_MODEL="$MODEL" \
  python3 "$HERE/dsh-pin-proxy.py" "$OUT/usage.jsonl" "$OUT/port" 2> "$OUT/proxy.stderr" &
PP=$!
disown "$PP"
K=""
for _ in $(seq 1 50); do [ -s "$OUT/port" ] && break; sleep 0.1; done
[ -s "$OUT/port" ] || fail "proxy did not start: $(tail -c 300 "$OUT/proxy.stderr" 2>/dev/null)"

DTMP=$(mktemp -d /private/tmp/dsh-tmp.XXXXXX) || fail "cannot create a temp dir for dsh"
cd "$WT" || fail "cannot enter $WT"
T0=$(date +%s)
# Mode pinned here, not inherited: DSH_PERMISSION_MODE=danger-full-access in the caller's env would
# turn dsh's sandbox off.
env -u OPENROUTER_API_KEY DSH_PERMISSION_MODE=workspace-write TMPDIR="$DTMP" DSH_TELEMETRY_DISABLED=1 \
  DSH_PROXY_BASE="http://127.0.0.1:$(cat "$OUT/port")" DSH_PROXY_DUMMY_KEY=via-proxy \
  DSH_MODEL="$MODEL" \
  timeout "${DSH_TIMEOUT:-1500}" "$DSH" --profile headless --patch "$HERE/dsh-openrouter.patch.yml" \
  --json - < "$TASK" > "$OUT/events.ndjson" 2> "$OUT/events.ndjson.stderr" &
DP=$!
wait "$DP"
rc=$?
kill_dsh
# Jobs that left the group but still run in the worktree; after this the tree is quiescent.
REAPED=$(python3 "$HERE/reap.py" "$WT" "$T0" "$$" "$PP" 2>/dev/null || echo '[]')
python3 "$HERE/dsh_summary.py" "$OUT/events.ndjson" "$OUT/usage.jsonl" "$rc" > "$OUT/summary.json"
python3 -c 'import json,sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    d = {"turns": 0, "is_error": True, "rc": int(sys.argv[3]), "turn_end": [], "usage": {},
         "result": "summary unreadable: %s" % e}
d["outdir"] = sys.argv[2]
try:
    d["reaped"] = json.loads(sys.argv[4])
except ValueError:
    d["reaped"] = []
print(json.dumps(d))
sys.exit(1 if d.get("is_error") else 0)' "$OUT/summary.json" "$OUT" "$rc" "$REAPED"
