#!/bin/bash
# shellcheck disable=SC2034  # variables are consumed by the sourced keepalive functions
# Offline test for bead 5il: an ADOPTED llama-server must get real provenance ids
# in qwen-server-state.json. adopt(), adopt_provenance(), prov_adopt_retry(),
# write_state(), json_esc(), prov_gate() and its helpers are extracted from
# keepalive-coprocessor.sh and driven with a fake ssh (decodes the encoded
# PowerShell, answers stat / owner-pid, captures the state json) and a fake
# provenance interpreter. No network, no box, no real python tool.
# Usage: /bin/bash scripts/ops/tests/test-keepalive-adopt-provenance.sh   (~10 s).
# Exits non-zero if any case is wrong. bash prints one "Alarm clock" line for the
# hang case: that SIGALRM is the b1y bound under test.
set -u
here=$(cd "$(dirname "$0")" && pwd)
ka="$here/../keepalive-coprocessor.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
sed -n -e '/^py_bounded() {/,/^}$/p' -e '/^prov_timeout() {/,/^}$/p' -e '/^boxlen() {/,/^}$/p' \
       -e '/^prov_gate() {/,/^}$/p' -e '/^json_esc() {/,/^}$/p' -e '/^write_state() {/,/^}$/p' \
       -e '/^adopt_provenance() {/,/^}$/p' -e '/^prov_adopt_retry() {/,/^}$/p' -e '/^adopt() {/,/^}$/p' "$ka" > "$tmp/fns.sh"
for f in py_bounded prov_timeout boxlen prov_gate json_esc write_state adopt_provenance prov_adopt_retry adopt; do
  grep -q "^$f() {" "$tmp/fns.sh" || { echo "FAIL: $f not found in $ka"; exit 1; }
done
grep -q 'overlay check-path' "$tmp/fns.sh" || { echo "FAIL: prov_gate block truncated"; exit 1; }

# Fake ssh: $1 = host, $2 = remote command. Behaviour from FAKE_* env vars.
cat > "$tmp/fake-ssh" <<'SSH'
#!/bin/bash
cmd=$2
case "$cmd" in
  *tasklist*) echo tasklist >> "$CALLS"; printf '"llama-server.exe","777","Services","0","1 K"\n'; exit 0 ;;
esac
script=$(printf '%s' "${cmd##* }" | base64 --decode | iconv -f UTF-16LE -t UTF-8)
case "$script" in
  OWNERPID*) echo ownerpid >> "$CALLS"; [ -n "${FAKE_OWNER:-}" ] && echo "$FAKE_OWNER" ;;
  *Set-Content*) printf '%s' "$script" | sed -e "s/^.*-Value '//" -e "s/'\$//" -e "s/''/'/g" > "$STATE_OUT" ;;
  *Length*) echo "stat $script" >> "$CALLS"; [ "${FAKE_STAT_FAIL:-0}" = 1 ] || echo 12345 ;;
esac
exit 0
SSH
# Fake provenance interpreter. -c = manifest read (1 arg) or overlay lookup (2 args).
cat > "$tmp/fake-py" <<'PY'
#!/bin/bash
echo "py $*" >> "$CALLS"
[ "${FAKE_HANG:-0}" = 1 ] && exec sleep 30
if [ "$1" = "-c" ]; then
  if [ -n "${4:-}" ]; then [ -n "${FAKE_OVERLAY:-}" ] && echo "$FAKE_OVERLAY"; exit 0; fi
  echo 1; exit 0
fi
# $1 = provenance.py, $2 = check-path, $3 = path
case "$3" in
  *.gguf)
    [ "${FAKE_MODEL_FAIL:-0}" = 1 ] && { echo "size mismatch: it's \"bad\" on C:\\models" >&2; exit 1; }
    echo "model-id@abc123" ;;
  *llama-server.exe) echo "llama.cpp@b-test-patched" ;;
  *.dll) [ "${FAKE_DLL_FAIL:-0}" = 1 ] && { echo "dll size differs" >&2; exit 1; } ;;
esac
exit 0
PY
chmod +x "$tmp/fake-ssh" "$tmp/fake-py"

REPO_DIR="$tmp/repo"; mkdir -p "$REPO_DIR/models" "$REPO_DIR/scripts/ops/provenance"
printf '{"artifacts": [{"id": "x"}]}' > "$REPO_DIR/models/MANIFEST.json"
PROV="$REPO_DIR/scripts/ops/provenance/provenance.py"; : > "$PROV"
CALLS="$tmp/calls"; STATE_OUT="$tmp/state.json"; export CALLS STATE_OUT
PYTHON="$tmp/fake-py"; PROV_PY_TIMEOUT=2
SSH="$tmp/fake-ssh"; HOST=box
OWNERPID_B64=$(printf 'OWNERPID' | iconv -t UTF-16LE | base64)
LL='C:\llama-test\llama-server.exe'; EXPECTED_BUILD="b-test-patched"
CODER_MODEL='C:\models\m.gguf'; CODER_MANIFEST_ID=""; MMPROJ_MODEL=""; MMPROJ_MANIFEST_ID=""
CODER="$LL -m $CODER_MODEL --port 1235"; VARIANT=""; ENVSET="X=1"
PROVENANCE_ENFORCE=1; LAUNCH_T0=0; CODER_PID=0; GPU_LAST=""; GPU_ALERT=""; EXPECTED_PID=0
PROV_MODEL_ID=""; PROV_RUNTIME_ID=""; PROV_MMPROJ_ID=""; PROV_REFUSED=0
PROV_GATE_STATE="not-run"; PROV_GATE_REASON=""; PROV_ADOPT_ALERT=""; PROV_RETRY_AT=0; PROV_RETRY_EVERY=300
. "$tmp/fns.sh"
log() { echo "$*" >> "$tmp/log"; }
gpu_check() { GPU_LAST="53 GB dedicated"; return 0; }
ownercmd() { echo "$FAKE_CMD"; }
reclaim() { echo "reclaim: $1" >> "$tmp/reclaims"; }
start_coder() { echo "start_coder" >> "$tmp/reclaims"; }
killremote() { echo "killremote" >> "$tmp/reclaims"; }
export FAKE_CMD="C:\\llama-test\\llama-server.exe -m C:\\models\\m.gguf --port 1235"

fails=0
expect() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: want [$2] got [$3]"; fails=$((fails+1)); fi; }
# jq-free field read from the captured state json; also proves the json parses
field() { python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): d=d[k]
print(d)' "$STATE_OUT" "$1" 2>/dev/null || echo "<UNPARSEABLE>"; }
reset() {
  : > "$CALLS"; : > "$tmp/log"; : > "$tmp/reclaims"; rm -f "$STATE_OUT"
  PROV_MODEL_ID=""; PROV_RUNTIME_ID=""; PROV_MMPROJ_ID=""; PROV_GATE_STATE="not-run"; PROV_GATE_REASON=""
  PROV_ADOPT_ALERT=""; PROV_RETRY_AT=0; EXPECTED_PID=0
  unset FAKE_OWNER FAKE_STAT_FAIL FAKE_OVERLAY FAKE_MODEL_FAIL FAKE_DLL_FAIL FAKE_HANG
  export FAKE_CMD="C:\\llama-test\\llama-server.exe -m C:\\models\\m.gguf --port 1235"
}

# 1: adopt of a verified cmdline -> real ids in the json, gate adopt-pass
reset; export FAKE_OWNER="4242 90"
adopt 4242
expect "adopt: model_id recorded"   "model-id@abc123"          "$(field provenance.model_id)"
expect "adopt: runtime_id recorded" "llama.cpp@b-test-patched" "$(field provenance.runtime_id)"
expect "adopt: gate adopt-pass"     "adopt-pass"               "$(field provenance.gate)"
expect "adopt: pid from owner query" "4242"                    "$(field pid)"
expect "adopt: nothing reclaimed"   ""                         "$(cat "$tmp/reclaims")"
expect "adopt: guard stays armed"   "4242"                     "$EXPECTED_PID"

# 2: the owner lookup in write_state returns pid 0 (the 2026-11 intermittent):
# the adopt-verified pid is used, tasklist is NOT, the guard stays armed
reset; export FAKE_OWNER="0 -1"
adopt 4242
expect "adopt+owner 0: pid is the verified one" "4242" "$(field pid)"
expect "adopt+owner 0: no tasklist fallback"    "0"    "$(grep -c '^tasklist' "$CALLS")"
expect "adopt+owner 0: EXPECTED_PID not reset"  "4242" "$EXPECTED_PID"
expect "adopt+owner 0: ids still recorded"      "model-id@abc123" "$(field provenance.model_id)"
# ...but write_state with no verified pid keeps the old behaviour
reset; export FAKE_OWNER="0 -1"
write_state
expect "write_state no known pid: tasklist fallback" "777/0" "$(field pid)/$EXPECTED_PID"

# 3: transient box-stat failure on adopt: server NOT torn down, honest record,
# ids empty, json valid, retry armed; later recovery fills the ids
reset; export FAKE_OWNER="4242 90" FAKE_STAT_FAIL=1
adopt 4242
expect "stat fail: gate adopt-fail"         "adopt-fail" "$(field provenance.gate)"
case "$(field provenance.gate_reason)" in *"could not stat"*) rr=ok ;; *) rr=bad ;; esac
expect "stat fail: reason recorded"         "ok" "$rr"
expect "stat fail: ids empty, not invented" "" "$(field provenance.model_id)$(field provenance.runtime_id)"
expect "stat fail: no reclaim/kill/start"   "" "$(cat "$tmp/reclaims")"
expect "stat fail: guard stays armed"       "4242" "$EXPECTED_PID"
expect "stat fail: one ALERT logged"        "1" "$(grep -c '^ALERT: provenance gate FAILED' "$tmp/log")"
SECONDS_SAVE=$SECONDS
prov_adopt_retry
expect "retry not due yet: no extra gate run" "0" "$(grep -c 'check-path' "$CALLS")"
PROV_RETRY_AT=$((SECONDS - 1)); unset FAKE_STAT_FAIL
prov_adopt_retry
expect "retry after recovery: gate adopt-pass" "adopt-pass" "$(field provenance.gate)"
expect "retry after recovery: ids filled"      "model-id@abc123" "$(field provenance.model_id)"
expect "retry after recovery: reason cleared"  "" "$(field provenance.gate_reason)"
expect "retry after recovery: no reclaim"      "" "$(cat "$tmp/reclaims")"

# 4: definitive failure, reason with quote/backslash/apostrophe: valid json, still no teardown
reset; export FAKE_OWNER="4242 90" FAKE_MODEL_FAIL=1
adopt 4242
expect "model fail: gate adopt-fail" "adopt-fail" "$(field provenance.gate)"
case "$(field provenance.gate_reason)" in *"it's \"bad\" on C:\\models"*) rr=ok ;; *) rr="got: $(field provenance.gate_reason)" ;; esac
expect "model fail: reason round-trips through json + PowerShell quoting" "ok" "$rr"
expect "model fail: no reclaim/kill/start" "" "$(cat "$tmp/reclaims")"
# the same alert is not re-logged on a second failing retry
PROV_RETRY_AT=$((SECONDS - 1)); prov_adopt_retry
expect "model fail: alert deduped across retries" "1" "$(grep -c '^ALERT: provenance gate FAILED' "$tmp/log")"

# 5: patched-DLL overlay on an adopted server is gated too
reset; export FAKE_OWNER="4242 90" FAKE_OVERLAY="ggml-vulkan.dll"
adopt 4242
expect "overlay: dll checked on adopt" "1" "$(grep -c 'check-path C:\\llama-test\\ggml-vulkan.dll' "$CALLS")"
expect "overlay: gate adopt-pass"      "adopt-pass" "$(field provenance.gate)"
reset; export FAKE_OWNER="4242 90" FAKE_OVERLAY="ggml-vulkan.dll" FAKE_DLL_FAIL=1
adopt 4242
expect "overlay fail: gate adopt-fail" "adopt-fail" "$(field provenance.gate)"
case "$(field provenance.gate_reason)" in *"overlay file not verified"*) rr=ok ;; *) rr="got: $(field provenance.gate_reason)" ;; esac
expect "overlay fail: reason names the dll" "ok" "$rr"
expect "overlay fail: no teardown" "" "$(cat "$tmp/reclaims")"

# 6: b1y bound still applies on adopt: a hung python fails the gate in ~2 s, server left alone
reset; export FAKE_OWNER="4242 90" FAKE_HANG=1
t0=$SECONDS; adopt 4242 2>/dev/null; el=$((SECONDS - t0))
expect "hang: gate adopt-fail" "adopt-fail" "$(field provenance.gate)"
case "$(field provenance.gate_reason)" in *"timed out after 2s"*) rr=ok ;; *) rr="got: $(field provenance.gate_reason)" ;; esac
expect "hang: timeout reason recorded" "ok" "$rr"
[ "$el" -le 8 ] && echo "ok   hang bounded (${el}s <= 8)" || { echo "FAIL hang took ${el}s"; fails=$((fails+1)); }
expect "hang: no teardown" "" "$(cat "$tmp/reclaims")"

# 7: a pass is cached for the process: a second adopt does not re-run the gate
reset; export FAKE_OWNER="4242 90"
adopt 4242; n1=$(grep -c 'check-path' "$CALLS"); adopt 4242; n2=$(grep -c 'check-path' "$CALLS")
expect "second adopt reuses the pass" "$n1" "$n2"

# 8: a foreign cmdline is still reclaimed and never gated or recorded
reset; export FAKE_OWNER="4242 90" FAKE_CMD='C:\llama-test\llama-server.exe -m other.gguf --cache-reuse 256'
adopt 4242
expect "foreign cmdline: reclaimed" "reclaim: foreign cmdline on :1235 (pid 4242)" "$(cat "$tmp/reclaims")"
expect "foreign cmdline: no gate run, no state written" "0/absent" "$(grep -c 'check-path' "$CALLS")/$([ -e "$STATE_OUT" ] && echo present || echo absent)"

# 9: a failed re-run must not leave an earlier pass's ids standing
reset; export FAKE_OWNER="4242 90"
PROV_MODEL_ID="stale@id"; PROV_RUNTIME_ID="stale-rt"; FAKE_STAT_FAIL=1; export FAKE_STAT_FAIL
prov_gate; rc=$?
expect "prov_gate resets ids before a failing run" "1/" "$rc/$PROV_MODEL_ID$PROV_RUNTIME_ID"

[ "$fails" -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
