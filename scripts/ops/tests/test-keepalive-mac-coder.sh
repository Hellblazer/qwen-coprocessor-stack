#!/bin/bash
# Offline test for coder-mac's provenance gate, reap patterns and probe-failure rule (bead 4f81):
# coder_prov_ok, extracted from keepalive-mac.sh, against the real manifest and the
# real provenance.py, over a snapshot directory of sparse files at the manifested sizes.
# Usage: bash scripts/ops/tests/test-keepalive-mac-coder.sh   (~3 s). Exits non-zero
# if any case is wrong.
set -u
here=$(cd "$(dirname "$0")" && pwd)
ka="$here/../keepalive-mac.sh"
REPO_ROOT=$(cd "$here/../../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
sed -n '/^coder_prov_ok(){$/,/^}$/p' "$ka" > "$tmp/fns.sh"
grep -q 'check-path' "$tmp/fns.sh" || { echo "FAIL: coder_prov_ok block not found in $ka"; exit 1; }
grep -E '^(CODER_MANIFEST_ID|CODER_FILE_COUNT|CODER_PAT|REASON_PAT|VISION_PAT)=' "$ka" | sed 's/[[:space:]]*#.*$//' >> "$tmp/fns.sh"
. "$tmp/fns.sh"
PROV="$REPO_ROOT/scripts/ops/provenance/provenance.py"
PYTHON=$(command -v python3)
LOGDIR="$tmp"
fails=0; PROV_REASON=""
expect() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: want $2 got $3 ($PROV_REASON)"; fails=$((fails+1)); fi; }

# Sparse stand-ins: check-path is membership + size, so content is irrelevant here.
mksnap() {
  rm -rf "$1"; mkdir -p "$1"
  "$PYTHON" - "$REPO_ROOT/models/MANIFEST.json" "$CODER_MANIFEST_ID" "$1" <<'EOF'
import json, os, sys
manifest, wanted, dest = sys.argv[1:]
entry = next(a for a in json.load(open(manifest))["artifacts"] if a["id"] == wanted)
for f in entry["files"]:
    with open(os.path.join(dest, f.get("local_path") or f["path"]), "wb") as fh:
        fh.truncate(f["size"])
print(len(entry["files"]))
EOF
}

CODER_SNAPSHOT="$tmp/snap"
n=$(mksnap "$CODER_SNAPSHOT")
expect "CODER_FILE_COUNT matches the manifest entry" "$n" "$CODER_FILE_COUNT"
[ "$n" -gt 0 ] || { echo "FAIL: manifest entry $CODER_MANIFEST_ID has no files (vacuous run)"; exit 1; }

coder_prov_ok; expect "intact snapshot passes" 0 $?

rm "$CODER_SNAPSHOT/model-00005-of-00009.safetensors"
coder_prov_ok; expect "a deleted shard refuses (count)" 1 $?

mksnap "$CODER_SNAPSHOT" >/dev/null
printf x >> "$CODER_SNAPSHOT/model-00009-of-00009.safetensors"
coder_prov_ok; expect "a shard of the wrong length refuses" 1 $?

mksnap "$CODER_SNAPSHOT" >/dev/null
: > "$CODER_SNAPSHOT/model-99999-of-00009.safetensors"
coder_prov_ok; expect "an unmanifested shard refuses" 1 $?

mksnap "$CODER_SNAPSHOT" >/dev/null
rm "$CODER_SNAPSHOT/tokenizer.json"
coder_prov_ok; expect "a missing tokenizer refuses" 1 $?

CODER_SNAPSHOT="$tmp/absent"
coder_prov_ok; expect "an absent snapshot refuses" 1 $?

CODER_SNAPSHOT="$tmp/snap"; mksnap "$CODER_SNAPSHOT" >/dev/null
keep=$CODER_MANIFEST_ID; CODER_MANIFEST_ID="no-such-entry@00000000"
coder_prov_ok; expect "an unknown manifest id refuses" 1 $?
CODER_MANIFEST_ID=$keep

# reason-mac and coder-mac are both mlx_lm.server: each pattern must match only its own.
coder="python /v/bin/mlx_lm.server --model /snap --host 0.0.0.0 --port 8085 --temp 0.7"
reason="python /v/bin/mlx_lm.server --model m/Qwen3.6 --host 0.0.0.0 --port 8084 --max-tokens 4096"
m() { printf '%s\n' "$2" | grep -Ec -- "$1"; }
expect "coder pattern matches coder-mac"       1 "$(m "$CODER_PAT" "$coder")"
expect "coder pattern spares reason-mac"       0 "$(m "$CODER_PAT" "$reason")"
expect "reason pattern matches reason-mac"     1 "$(m "$REASON_PAT" "$reason")"
expect "reason pattern spares coder-mac"       0 "$(m "$REASON_PAT" "$coder")"
expect "coder pattern spares a bench on :80850" 0 "$(m "$CODER_PAT" "python /v/bin/mlx_lm.server --model /snap --port 80850 --temp 0.7")"
expect "coder pattern matches a trailing --port" 1 "$(m "$CODER_PAT" "python /v/bin/mlx_lm.server --model /snap --port 8085")"
# A second mlx_vlm.server (a bench, a trial model) must not read as a vision-mac duplicate.
expect "vision pattern matches vision-mac"      1 "$(m "$VISION_PAT" "Python /v/bin/mlx_vlm.server --model m/Qwen2.5-VL --host 0.0.0.0 --port 8083")"
expect "vision pattern spares a trial on :8086" 0 "$(m "$VISION_PAT" "Python /v/bin/mlx_vlm.server --model /snap --host 127.0.0.1 --port 8086")"

# ensure_mlx: a server that still holds its port is not reaped on one failed probe.
sed -n '/^ensure_mlx() {$/,/^}$/p' "$ka" > "$tmp/ens.sh"
grep -q 'PROBE_FAILS_MAX' "$tmp/ens.sh" || { echo "FAIL: ensure_mlx block not found in $ka"; exit 1; }
. "$tmp/ens.sh"
MIN_FREE_GB=6; PROBE_FAILS_MAX=3
log() { :; }
PROBE=1; HELD=1; MEM=0; STARTED=0
probe() { return "$PROBE"; }
lsof() { return "$HELD"; }
mem_ok() { return "$MEM"; }
startfn() { STARTED=$((STARTED+1)); }
tick() { ensure_mlx 8085 t T_PID T_DL startfn 50 probe; }
reset() { T_PID=0; T_DL=0; T_PROBE_FAILS=0; STARTED=0; PROBE=1; HELD=1; MEM=0; }

reset; PROBE=0; T_DL=5; tick
expect "healthy: no spawn, deadline cleared" "0/0" "$STARTED/$T_DL"
reset; tick
expect "down, port free: spawn at once" 1 "$STARTED"
reset; sleep 30 & T_PID=$!; T_DL=$(( $(date +%s) + 60 )); tick
expect "loading within budget: left alone" 0 "$STARTED"
T_DL=1; HELD=0; tick; tick
expect "past budget, port held: two failed probes do not reap" "0/2" "$STARTED/$T_PROBE_FAILS"
PROBE=0; tick; PROBE=1; tick
expect "a good probe resets the streak" "0/1" "$STARTED/$T_PROBE_FAILS"
tick; tick
expect "third failed probe in a row reaps" "1/0" "$STARTED/$T_PROBE_FAILS"
kill "$T_PID" 2>/dev/null; wait "$T_PID" 2>/dev/null
reset; MEM=1; tick
expect "memory floor defers the spawn" 0 "$STARTED"
[ "$fails" -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
