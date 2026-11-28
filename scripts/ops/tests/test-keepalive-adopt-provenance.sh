#!/bin/bash
# shellcheck disable=SC2034  # variables are consumed by the sourced keepalive functions
# Offline test for bead 5il: an ADOPTED llama-server must get real provenance ids
# in qwen-server-state.json, and a failed or stale gate must be recorded honestly.
# adopt(), adopt_provenance(), prov_adopt_retry(), write_state(), json_esc(),
# prov_gate(), start_coder() and the main loop are extracted from
# keepalive-coprocessor.sh and driven with a fake ssh (decodes the encoded
# PowerShell, answers stat / owner-pid, captures the state json and REJECTS a
# payload a real PowerShell '...' literal would choke on) and a fake provenance
# interpreter. No network, no box, no real python tool.
# Usage: /bin/bash scripts/ops/tests/test-keepalive-adopt-provenance.sh   (~25 s).
# Exits non-zero if any case is wrong. bash prints one "Alarm clock" line for the
# hang case: that SIGALRM is the b1y bound under test.
set -u
# probe_off_set notifies through osascript: never post real notifications from a test.
export QWEN_KEEPALIVE_NOTIFY=0
here=$(cd "$(dirname "$0")" && pwd)
ka="$here/../keepalive-coprocessor.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
sed -n -e '/^py_bounded() {/,/^}$/p' -e '/^prov_timeout() {/,/^}$/p' -e '/^boxlen() {/,/^}$/p' \
       -e '/^prov_gate() {/,/^}$/p' -e '/^json_esc() {/,/^}$/p' -e '/^write_state() {/,/^}$/p' \
       -e '/^prov_reason_class() {/,/^}$/p' -e '/^prov_mark() {/,/^}$/p' -e '/^prov_ids_clear() {.*}$/p' -e '/^ownerpid() {.*}$/p' \
       -e '/^adopt_provenance() {/,/^}$/p' -e '/^prov_adopt_retry() {/,/^}$/p' -e '/^adopt() {/,/^}$/p' \
       -e '/^start_coder() {/,/^}$/p' "$ka" > "$tmp/fns.sh"
for f in py_bounded prov_timeout boxlen prov_gate json_esc write_state prov_reason_class prov_mark prov_ids_clear ownerpid \
         adopt_provenance prov_adopt_retry adopt start_coder; do
  grep -q "^$f() {" "$tmp/fns.sh" || { echo "FAIL: $f not found in $ka"; exit 1; }
done
grep -q 'overlay check-path' "$tmp/fns.sh" || { echo "FAIL: prov_gate block truncated"; exit 1; }
# The main loop, one iteration: the trailing sleep becomes a break.
sed -n '/^CYC=0$/,$p' "$ka" | sed -e 's/^  sleep 20$/  break/' -e 's/^CYC=0$/CYC=${CYC0:-0}/' > "$tmp/loop.sh"
grep -q '^  break$' "$tmp/loop.sh" || { echo "FAIL: main loop not found in $ka"; exit 1; }

# Fake ssh: $1 = host, $2 = remote command. Behaviour from FAKE_* env vars.
# Owner pid: FAKE_OWNER, or one line per call from the file OWNER_SEQ (last line repeats).
cat > "$tmp/fake-ssh" <<'SSH'
#!/bin/bash
cmd=$2
case "$cmd" in
  *tasklist*) echo tasklist >> "$CALLS"; printf '"llama-server.exe","777","Services","0","1 K"\n'; exit 0 ;;
esac
script=$(printf '%s' "${cmd##* }" | base64 --decode | iconv -f UTF-16LE -t UTF-8)
case "$script" in
  OWNERPID*)
    echo ownerpid >> "$CALLS"
    if [ -n "${OWNER_SEQ:-}" ] && [ -s "$OWNER_SEQ" ]; then
      head -1 "$OWNER_SEQ"
      [ "$(wc -l < "$OWNER_SEQ")" -gt 1 ] && { tail -n +2 "$OWNER_SEQ" > "$OWNER_SEQ.n"; mv "$OWNER_SEQ.n" "$OWNER_SEQ"; }
    elif [ -n "${FAKE_OWNER:-}" ]; then echo "$FAKE_OWNER"; fi ;;
  *Set-Content*)
    payload=$(printf '%s' "$script" | sed -e "s/^.*-Value '//" -e "s/'\$//")
    # PowerShell '...' literal: a lone ' ends the string. Only '' pairs are legal inside.
    q="'"; stripped=${payload//$q$q/}
    if [[ "$stripped" == *"$q"* ]]; then echo "lone-quote" >> "$CALLS"; printf 'REJECTED: lone single quote' > "$STATE_OUT"
    else printf '%s' "${payload//$q$q/$q}" > "$STATE_OUT"; fi ;;
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
CALLS="$tmp/calls"; STATE_OUT="$tmp/state.json"; OWNER_SEQ="$tmp/owner-seq"; export CALLS STATE_OUT OWNER_SEQ
PYTHON="$tmp/fake-py"; PROV_PY_TIMEOUT=2
SSH="$tmp/fake-ssh"; HOST=box
OWNERPID_B64=$(printf 'OWNERPID' | iconv -t UTF-16LE | base64)
LL='C:\llama-test\llama-server.exe'; EXPECTED_BUILD="b-test-patched"
CODER_MODEL='C:\models\m.gguf'; CODER_MANIFEST_ID=""; MMPROJ_MODEL=""; MMPROJ_MANIFEST_ID=""
CODER="$LL -m $CODER_MODEL --port 1235"; VARIANT=""; ENVSET="X=1"
PROVENANCE_ENFORCE=1; LAUNCH_T0=0; CODER_PID=0; GPU_LAST=""; GPU_ALERT=""; EXPECTED_PID=0
PROV_MODEL_ID=""; PROV_RUNTIME_ID=""; PROV_MMPROJ_ID=""; PROV_REFUSED=0
PROV_GATE_STATE="not-run"; PROV_GATE_REASON=""; PROV_GATE_CLASS="none"; PROV_GATE_PID=""; PROV_GATE_AT=""; PROV_GATE_T=0
PROV_ADOPT_ALERT=""; PROV_ADOPT_ALERT_T=0; PROV_FAIL_STREAK=0; PROV_RETRY_AT=0
PROV_RETRY_FIRST=60; PROV_RETRY_EVERY=300; PROV_REGATE_EVERY=3600; LAUNCHED_AT=""; LAUNCHED_PID=""
PREFLIGHT_ENFORCE=1; PREFLIGHT_REFUSED=0; PREFLIGHT_ALERT=""; LAUNCH_DEAD=0; GPU_FAILS=0; MAX_GPU_RETRIES=2
GUARDS_DOWN=0; CYC=0; PIDCHECK_EVERY=15; GPUCHK_EVERY=45; OWNERPID_DARK=0; RECLAIMS=0
. "$tmp/fns.sh"
log() { echo "$*" >> "$tmp/log"; }
gpu_check() {
  if [ "${FAKE_GPU_FAIL:-0}" = 1 ]; then GPU_REASON="below the residency band"; GPU_LAST="1 GB dedicated"; return 1; fi
  GPU_LAST="53 GB dedicated"; return 0
}
ownercmd() { echo "$FAKE_CMD"; }
reclaim() { echo "reclaim: $1" >> "$tmp/reclaims"; }
killremote() { echo "killremote" >> "$tmp/reclaims"; }
kpid() { :; }
sleep() { :; }
wait_for_session() { :; }
preflight() { return 0; }
waitup() { return 0; }

fails=0
expect() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: want [$2] got [$3]"; fails=$((fails+1)); fi; }
# jq-free field read from the captured state json; also proves the json parses
field() { python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): d=d[k]
print(d)' "$STATE_OUT" "$1" 2>/dev/null || echo "<UNPARSEABLE>"; }
count() { grep -c "$1" "$2" 2>/dev/null; true; }   # grep -c prints 0 AND exits 1 on no match
reset() {
  : > "$CALLS"; : > "$tmp/log"; : > "$tmp/reclaims"; rm -f "$STATE_OUT" "$OWNER_SEQ" "$tmp/marks"
  PROV_MODEL_ID=""; PROV_RUNTIME_ID=""; PROV_MMPROJ_ID=""; PROV_GATE_STATE="not-run"; PROV_GATE_REASON=""; PROV_GATE_CLASS="none"
  PROV_GATE_PID=""; PROV_GATE_AT=""; PROV_GATE_T=0; PROV_ADOPT_ALERT=""; PROV_ADOPT_ALERT_T=0; PROV_FAIL_STREAK=0
  PROV_RETRY_AT=0; EXPECTED_PID=0; LAUNCHED_AT=""; LAUNCHED_PID=""; PROVENANCE_ENFORCE=1; GPU_ALERT=""; GUARDS_DOWN=0
  unset FAKE_OWNER FAKE_GPU_FAIL FAKE_STAT_FAIL FAKE_OVERLAY FAKE_MODEL_FAIL FAKE_DLL_FAIL FAKE_HANG
  export FAKE_CMD="C:\\llama-test\\llama-server.exe -m C:\\models\\m.gguf --port 1235"
}
nstat() { count '^stat' "$CALLS"; }

# 1: adopt of a verified cmdline -> real ids in the json, gate adopt-pass for that pid
reset; export FAKE_OWNER="4242 90"
adopt 4242
expect "adopt: model_id recorded"   "model-id@abc123"          "$(field provenance.model_id)"
expect "adopt: runtime_id recorded" "llama.cpp@b-test-patched" "$(field provenance.runtime_id)"
expect "adopt: gate adopt-pass"     "adopt-pass"               "$(field provenance.gate)"
expect "adopt: gate_pid is the adopted pid" "4242"             "$(field provenance.gate_pid)"
case "$(field provenance.gate_at)" in 20*) rr=ok ;; *) rr="got: $(field provenance.gate_at)" ;; esac
expect "adopt: gate_at is a timestamp" "ok" "$rr"
expect "adopt: pid + pid_source"    "4242/owner-query"         "$(field pid)/$(field pid_source)"
expect "adopt: nothing reclaimed"   ""                         "$(cat "$tmp/reclaims")"
expect "adopt: guard stays armed"   "4242"                     "$EXPECTED_PID"

# 2: the owner lookup returns pid 0 (the bead ffjq episodes): the adopt-verified pid
# is used, labelled caller-verified; tasklist is NOT consulted; the guard stays armed
reset; export FAKE_OWNER="0 -1"
adopt 4242
expect "owner 0: pid + pid_source"       "4242/caller-verified" "$(field pid)/$(field pid_source)"
expect "owner 0: no tasklist fallback"   "0"    "$(count '^tasklist' "$CALLS")"
expect "owner 0: EXPECTED_PID kept"      "4242" "$EXPECTED_PID"
expect "owner 0: ids still recorded"     "model-id@abc123" "$(field provenance.model_id)"
reset; export FAKE_OWNER="0 -1"
write_state
expect "write_state, no known pid: tasklist fallback" "777/0/tasklist-fallback" "$(field pid)/$EXPECTED_PID/$(field pid_source)"

# 3 (critic B1): the owner changes during adoption (after the gate and gpu_check):
# nothing recorded, nothing armed
reset; printf '9999 5\n' > "$OWNER_SEQ"
adopt 4242
expect "owner changed during adopt: no state written" "absent" "$([ -e "$STATE_OUT" ] && echo present || echo absent)"
expect "owner changed during adopt: guard not armed"  "0"      "$EXPECTED_PID"
# write_state itself refuses to arm when the live owner differs from the verified pid
reset; export FAKE_OWNER="9999 5"
write_state 4242
expect "write_state known != live: not armed, nothing written" "0/absent" "$EXPECTED_PID/$([ -e "$STATE_OUT" ] && echo present || echo absent)"
expect "write_state known != live: logged" "1" "$(count 'not the verified 4242' "$tmp/log")"

# 4 (critic B1, probe A): adopt under adopt-fail, then the owner changes; the retry
# must not re-arm, write, or gate
reset; export FAKE_OWNER="4242 90" FAKE_STAT_FAIL=1
adopt 4242
expect "retry setup: adopt-fail, armed on 4242" "adopt-fail/4242" "$(field provenance.gate)/$EXPECTED_PID"
export FAKE_OWNER="9999 5"; rm -f "$STATE_OUT"; n0=$(nstat)
PROV_RETRY_AT=$((SECONDS - 1)); prov_adopt_retry
expect "owner changed at retry: EXPECTED_PID cleared, not 9999" "0" "$EXPECTED_PID"
expect "owner changed at retry: nothing written" "absent" "$([ -e "$STATE_OUT" ] && echo present || echo absent)"
expect "owner changed at retry: gate not re-run" "$n0" "$(nstat)"
# owner unreadable at retry: no write, retry deferred ~60 s
reset; export FAKE_OWNER="4242 90" FAKE_STAT_FAIL=1; adopt 4242
export FAKE_OWNER="0 -1"; rm -f "$STATE_OUT"; PROV_RETRY_AT=$((SECONDS - 1)); prov_adopt_retry
expect "owner dark at retry: nothing written, still armed" "absent/4242" "$([ -e "$STATE_OUT" ] && echo present || echo absent)/$EXPECTED_PID"

# 5: transient box-stat failure on adopt: no teardown, honest record, ids empty,
# retry throttled (first retry ~60 s, then 300 s), same-reason alert once
reset; export FAKE_OWNER="4242 90" FAKE_STAT_FAIL=1
adopt 4242
expect "stat fail: gate adopt-fail"         "adopt-fail" "$(field provenance.gate)"
case "$(field provenance.gate_reason)" in *"could not stat"*) rr=ok ;; *) rr=bad ;; esac
expect "stat fail: reason recorded"         "ok" "$rr"
expect "stat fail: ids empty"               "" "$(field provenance.model_id)$(field provenance.runtime_id)"
expect "stat fail: no reclaim/kill/start"   "" "$(cat "$tmp/reclaims")"
expect "stat fail: guard stays armed"       "4242" "$EXPECTED_PID"
expect "stat fail: one ALERT logged"        "1" "$(count '^ALERT: provenance gate FAILED' "$tmp/log")"
d=$((PROV_RETRY_AT - SECONDS)); [ "$d" -ge 55 ] && [ "$d" -le 60 ] && dd=ok || dd="got $d"
expect "stat fail: first retry of a transient reason in ~60 s" "ok" "$dd"
# critic probe/review N1: adopt() re-runs every 20 s while EXPECTED_PID is 0 -- the gate must not
n0=$(nstat); EXPECTED_PID=0; adopt 4242
expect "re-adopt inside the retry window does not re-gate" "$n0" "$(nstat)"
PROV_RETRY_AT=$((SECONDS - 1)); EXPECTED_PID=0; adopt 4242
d=$((PROV_RETRY_AT - SECONDS)); [ "$d" -ge 295 ] && [ "$d" -le 300 ] && dd=ok || dd="got $d"
expect "second failure backs off to 300 s" "ok" "$dd"
# hourly re-alert on a standing failure (critic N5)
PROV_ADOPT_ALERT_T=$((SECONDS - 3601)); PROV_RETRY_AT=$((SECONDS - 1)); EXPECTED_PID=0; adopt 4242
expect "standing adopt-fail re-alerts hourly" "2" "$(count '^ALERT: provenance gate FAILED' "$tmp/log")"
# recovery through the retry hook, same owner: pass, ids filled, launched_at kept
unset FAKE_STAT_FAIL; l0=$(field launched_at); command sleep 1
PROV_RETRY_AT=$((SECONDS - 1)); prov_adopt_retry
expect "retry after recovery: adopt-pass, ids filled" "adopt-pass/model-id@abc123" "$(field provenance.gate)/$(field provenance.model_id)"
expect "retry after recovery: reason cleared"   "" "$(field provenance.gate_reason)"
expect "retry after recovery: launched_at not rewritten" "$l0" "$(field launched_at)"
expect "retry after recovery: no reclaim"       "" "$(cat "$tmp/reclaims")"

# 6: definitive failure; reason with quote/backslash/apostrophe. The fake ssh REJECTS a
# lone ' in the payload, so removing json_esc's apostrophe doubling turns this red.
reset; export FAKE_OWNER="4242 90" FAKE_MODEL_FAIL=1
adopt 4242
expect "model fail: gate adopt-fail" "adopt-fail" "$(field provenance.gate)"
case "$(field provenance.gate_reason)" in *"it's \"bad\" on C:\\models"*) rr=ok ;; *) rr="got: $(field provenance.gate_reason)" ;; esac
expect "model fail: reason round-trips through json + PowerShell quoting" "ok" "$rr"
expect "model fail: payload never had a lone quote" "0" "$(count '^lone-quote' "$CALLS")"
expect "model fail: no reclaim/kill/start" "" "$(cat "$tmp/reclaims")"
# control characters become spaces, the json stays valid (code-review N4)
reset; export FAKE_OWNER="4242 90"
PROV_GATE_REASON=$(printf 'a\tb\001c\033d'); PROV_GATE_STATE=adopt-fail
write_state 4242
expect "control chars in a reason: json valid, mapped to spaces" "a b c d" "$(field provenance.gate_reason)"

# 7 (code-review B1): overlay DLL failure clears ALL ids -- no half-verified set stands
reset; export FAKE_OWNER="4242 90" FAKE_OVERLAY="ggml-vulkan.dll"
adopt 4242
expect "overlay: dll checked on adopt" "1" "$(count 'check-path C:\\llama-test\\ggml-vulkan.dll' "$CALLS")"
expect "overlay: gate adopt-pass"      "adopt-pass" "$(field provenance.gate)"
reset; export FAKE_OWNER="4242 90" FAKE_OVERLAY="ggml-vulkan.dll" FAKE_DLL_FAIL=1
adopt 4242
expect "overlay fail: gate adopt-fail" "adopt-fail" "$(field provenance.gate)"
expect "overlay fail: model, runtime, mmproj ids all empty" "///" "$(field provenance.model_id)/$(field provenance.runtime_id)/$(field provenance.mmproj_id)/"
case "$(field provenance.gate_reason)" in *"overlay file not verified"*) rr=ok ;; *) rr="got: $(field provenance.gate_reason)" ;; esac
expect "overlay fail: reason names the dll" "ok" "$rr"
expect "overlay fail: no teardown" "" "$(cat "$tmp/reclaims")"
# prov_gate on its own commits nothing on failure
reset; PROV_MODEL_ID="keep@id"; PROV_RUNTIME_ID="keep-rt"; PROV_MMPROJ_ID=""; FAKE_OVERLAY="ggml-vulkan.dll" FAKE_DLL_FAIL=1
export FAKE_OVERLAY FAKE_DLL_FAIL
prov_gate; rc=$?
expect "prov_gate failure leaves the globals untouched" "1/keep@id/keep-rt" "$rc/$PROV_MODEL_ID/$PROV_RUNTIME_ID"

# 8 (critic B2/N2, code-review B2): a refused launch gate keeps the last pass's ids,
# and the state json says the last gate was refused rather than still "pass"
reset; export FAKE_OWNER="4242 90"; adopt 4242
export FAKE_STAT_FAIL=1; start_coder; rc=$?
expect "refused launch: start_coder returns 1" "1" "$rc"
expect "refused launch: state is launch-refused, ids kept" "launch-refused/model-id@abc123" "$PROV_GATE_STATE/$PROV_MODEL_ID"
write_state 4242
expect "refused launch then write_state: json says refused, ids and gate_pid intact" \
  "launch-refused/model-id@abc123/4242" "$(field provenance.gate)/$(field provenance.model_id)/$(field provenance.gate_pid)"
expect "refused launch: nothing killed" "" "$(cat "$tmp/reclaims")"
# bypass launch (ENFORCE=0): launches, ids cleared, state launch-bypass; an adopt result never overwrites it
reset; export FAKE_OWNER="4242 90"; adopt 4242
PROVENANCE_ENFORCE=0; export FAKE_STAT_FAIL=1; start_coder; rc=$?
expect "bypass launch: proceeds" "0" "$rc"
expect "bypass launch: state launch-bypass, ids cleared" "launch-bypass/" "$PROV_GATE_STATE/$PROV_MODEL_ID"
unset FAKE_STAT_FAIL; n0=$(nstat); EXPECTED_PID=0; export FAKE_OWNER="5151 3"; adopt 5151
expect "adopt after a bypass launch: state stays launch-bypass, no gate" "launch-bypass/$n0" "$PROV_GATE_STATE/$(nstat)"
# passing launch: launch-pass, bound to the owner pid by the first write, launched_at stamped
reset; export FAKE_OWNER="7000 5"; start_coder; rc=$?
expect "pass launch: launch-pass + ids" "0/launch-pass/model-id@abc123" "$rc/$PROV_GATE_STATE/$PROV_MODEL_ID"
expect "pass launch: json gate_pid bound to the owner" "7000" "$(field provenance.gate_pid)"
expect "pass launch: launched_at stamped" "ok" "$([ -n "$(field launched_at)" ] && echo ok)"

# 9 (critic N1/probe B): a pass is keyed on the pid, and goes stale
reset; export FAKE_OWNER="4242 90"; adopt 4242
export FAKE_OWNER="5555 3" FAKE_STAT_FAIL=1; EXPECTED_PID=0; adopt 5555
expect "new pid is re-gated: adopt-fail for 5555, ids cleared" "adopt-fail/5555//" "$(field provenance.gate)/$(field provenance.gate_pid)/$(field provenance.model_id)/"
reset; export FAKE_OWNER="4242 90"; adopt 4242; n1=$(count 'check-path' "$CALLS"); EXPECTED_PID=0; adopt 4242
expect "same pid, fresh pass: gate reused" "$n1" "$(count 'check-path' "$CALLS")"
PROV_GATE_T=$((SECONDS - 3700)); EXPECTED_PID=0; adopt 4242
n2=$(count 'check-path' "$CALLS"); [ "$n2" -gt "$n1" ] && rr=ok || rr="no re-gate ($n1 -> $n2)"
expect "same pid, pass older than 1 h: re-gated" "ok" "$rr"
# the hourly re-gate is driven by the main-loop hook on an adopt-pass
reset; export FAKE_OWNER="4242 90"; adopt 4242; n1=$(count 'check-path' "$CALLS")
PROV_GATE_T=$((SECONDS - 3700)); PROV_RETRY_AT=$((SECONDS - 1)); prov_adopt_retry
n2=$(count 'check-path' "$CALLS"); [ "$n2" -gt "$n1" ] && rr=ok || rr="no re-gate ($n1 -> $n2)"
expect "prov_adopt_retry re-gates a stale adopt-pass" "ok" "$rr"

# 10 (critic N6): ENFORCE=0 on adopt records a bypass, not a failure, and does not ALERT
reset; export FAKE_OWNER="4242 90" FAKE_STAT_FAIL=1; PROVENANCE_ENFORCE=0
adopt 4242
expect "adopt with ENFORCE=0: adopt-bypass" "adopt-bypass" "$(field provenance.gate)"
expect "adopt with ENFORCE=0: no failure ALERT" "0" "$(count '^ALERT: provenance gate FAILED' "$tmp/log")"

# 11: b1y bound still applies on adopt
reset; export FAKE_OWNER="4242 90" FAKE_HANG=1
t0=$SECONDS; adopt 4242 2>/dev/null; el=$((SECONDS - t0))
expect "hang: gate adopt-fail" "adopt-fail" "$(field provenance.gate)"
case "$(field provenance.gate_reason)" in *"timed out after 2s"*) rr=ok ;; *) rr="got: $(field provenance.gate_reason)" ;; esac
expect "hang: timeout reason recorded" "ok" "$rr"
[ "$el" -le 8 ] && echo "ok   hang bounded (${el}s <= 8)" || { echo "FAIL hang took ${el}s"; fails=$((fails+1)); }
expect "hang: no teardown" "" "$(cat "$tmp/reclaims")"
d=$((PROV_RETRY_AT - SECONDS)); [ "$d" -ge 55 ] && [ "$d" -le 60 ] && dd=ok || dd="got $d"
expect "hang counts as transient: ~60 s first retry" "ok" "$dd"

# 12: a foreign cmdline is still reclaimed and never gated or recorded
reset; export FAKE_OWNER="4242 90" FAKE_CMD='C:\llama-test\llama-server.exe -m other.gguf --cache-reuse 256'
adopt 4242
expect "foreign cmdline: reclaimed" "reclaim: foreign cmdline on :1235 (pid 4242)" "$(cat "$tmp/reclaims")"
expect "foreign cmdline: no gate run, no state written" "0/absent" "$(count 'check-path' "$CALLS")/$([ -e "$STATE_OUT" ] && echo present || echo absent)"

# 13 (code-review N3, N1): the main loop wires prov_adopt_retry in BOTH the normal and the
# guards-down branch, and passes the verified pid to the GPU-driven write_state calls
run_loop() {  # one main-loop iteration with the liveness/identity probes stubbed healthy
  (
    up() { return 0; }; probe_step() { return 0; }; buildok() { return 0; }
    prov_adopt_retry() { echo retry >> "$tmp/marks"; }
    # With STUB_ADOPT set, adopt() is a marker: the identity-guard branch of the
    # loop would otherwise arm a pid (legitimately) and hide what the GPU block did.
    [ -n "${STUB_ADOPT:-}" ] && adopt() { echo "adopt $1" >> "$tmp/marks"; }
    # shellcheck disable=SC1091
    . "$tmp/loop.sh"
    echo "$EXPECTED_PID" > "$tmp/loop-expected"   # the loop runs in a subshell: export its verdict
  )
}
reset; EXPECTED_PID=4242; run_loop
expect "main loop: normal branch runs prov_adopt_retry" "1" "$(count '^retry' "$tmp/marks")"
reset; EXPECTED_PID=4242; GUARDS_DOWN=1; run_loop
expect "main loop: guards-down branch still runs prov_adopt_retry" "1" "$(count '^retry' "$tmp/marks")"
# GPU recovery write: with the owner lookup dark it must carry the verified pid, not tasklist
reset; export FAKE_OWNER="0 -1"; EXPECTED_PID=4242; GPU_ALERT="old alert"; CYC0=44 run_loop
expect "main loop GPU write passes EXPECTED_PID" "4242/caller-verified/0" "$(field pid)/$(field pid_source)/$(count '^tasklist' "$CALLS")"

# item 1: GPU block with EXPECTED_PID=0 must not arm or write whatever owns :1235 (owner 9999)
reset; export FAKE_OWNER="9999 5"; EXPECTED_PID=0; GPU_ALERT="old alert"; STUB_ADOPT=1 CYC0=44 run_loop
expect "GPU recovery, EXPECTED_PID=0: nothing armed, nothing written" "0/absent" "$(cat "$tmp/loop-expected")/$([ -e "$STATE_OUT" ] && echo present || echo absent)"
reset; export FAKE_OWNER="9999 5"; EXPECTED_PID=0; GPU_ALERT=""; FAKE_GPU_FAIL=1 STUB_ADOPT=1 CYC0=44 run_loop
expect "GPU alert, EXPECTED_PID=0: nothing armed, nothing written" "0/absent" "$(cat "$tmp/loop-expected")/$([ -e "$STATE_OUT" ] && echo present || echo absent)"
reset; export FAKE_OWNER="4242 90"; EXPECTED_PID=4242; GPU_ALERT=""; FAKE_GPU_FAIL=1 CYC0=44 run_loop
expect "GPU alert, EXPECTED_PID>0: written and gpu_alert recorded" "4242/below the residency band" "$(field pid)/$(field gpu_alert)"

# item 3: launched_at follows the pid it was stamped for
reset; export FAKE_OWNER="4242 90"; adopt 4242; l0=$(field launched_at); command sleep 1
EXPECTED_PID=0; adopt 4242
expect "re-adopting the SAME pid keeps launched_at" "$l0" "$(field launched_at)"
export FAKE_OWNER="5555 3"; EXPECTED_PID=0; adopt 5555
[ "$(field launched_at)" != "$l0" ] && rr=ok || rr="stale $l0"
expect "adopting a DIFFERENT pid restamps launched_at" "ok" "$rr"

# 14 (bead 5il, Sam's adopt-refusal-policy): the state json records whether a gate failure is
# transient or definitive in gate_class, from ONE classifier shared with the retry delay.
# adopt pass: no failure recorded -> none
reset; export FAKE_OWNER="4242 90"; adopt 4242
expect "gate_class: adopt pass is none" "adopt-pass/none" "$(field provenance.gate)/$(field provenance.gate_class)"
# transient: box stat failure
reset; export FAKE_OWNER="4242 90" FAKE_STAT_FAIL=1; adopt 4242
expect "gate_class: could-not-stat adopt-fail is transient" "adopt-fail/transient" "$(field provenance.gate)/$(field provenance.gate_class)"
expect "gate_class: transient failure never stops the server" "" "$(cat "$tmp/reclaims")"
case "$(cat "$tmp/log")" in *"(pid 4242, transient)"*"gate_class transient"*) rr=ok ;; *) rr="got: $(cat "$tmp/log")" ;; esac
expect "gate_class: first alert names the class" "ok" "$rr"
# hourly re-alert on a standing failure names the class too
: > "$tmp/log"; PROV_ADOPT_ALERT_T=$((SECONDS - 3601)); PROV_RETRY_AT=$((SECONDS - 1)); EXPECTED_PID=0; adopt 4242
expect "gate_class: hourly re-alert names the class" "1" "$(count '^ALERT: provenance gate FAILED on the adopted server (pid 4242, transient)' "$tmp/log")"
# transient: TCC timeout
reset; export FAKE_OWNER="4242 90" FAKE_HANG=1; adopt 4242 2>/dev/null
expect "gate_class: timed-out adopt-fail is transient" "adopt-fail/transient" "$(field provenance.gate)/$(field provenance.gate_class)"
# definitive: unmanifested/mismatched model
reset; export FAKE_OWNER="4242 90" FAKE_MODEL_FAIL=1; adopt 4242
expect "gate_class: unverified model adopt-fail is definitive" "adopt-fail/definitive" "$(field provenance.gate)/$(field provenance.gate_class)"
expect "gate_class: definitive failure still never stops the server" "" "$(cat "$tmp/reclaims")"
case "$(cat "$tmp/log")" in *"(pid 4242, definitive)"*) rr=ok ;; *) rr="got: $(cat "$tmp/log")" ;; esac
expect "gate_class: definitive alert names the class" "ok" "$rr"
d=$((PROV_RETRY_AT - SECONDS)); [ "$d" -ge 295 ] && [ "$d" -le 300 ] && dd=ok || dd="got $d"
expect "gate_class: definitive first failure retries at 300 s (same classifier as the delay)" "ok" "$dd"
# definitive: overlay DLL
reset; export FAKE_OWNER="4242 90" FAKE_OVERLAY="ggml-vulkan.dll" FAKE_DLL_FAIL=1; adopt 4242
expect "gate_class: overlay failure is definitive" "definitive" "$(field provenance.gate_class)"
# bypass: the failure is still classified
reset; export FAKE_OWNER="4242 90" FAKE_STAT_FAIL=1; PROVENANCE_ENFORCE=0; adopt 4242
expect "gate_class: adopt-bypass carries the class" "adopt-bypass/transient" "$(field provenance.gate)/$(field provenance.gate_class)"
# transient -> pass clears it (retry hook, same owner)
reset; export FAKE_OWNER="4242 90" FAKE_STAT_FAIL=1; adopt 4242
unset FAKE_STAT_FAIL; PROV_RETRY_AT=$((SECONDS - 1)); prov_adopt_retry
expect "gate_class: transient then pass clears to none" "adopt-pass/none/" "$(field provenance.gate)/$(field provenance.gate_class)/$(field provenance.gate_reason)"
# definitive -> pass clears it too
reset; export FAKE_OWNER="4242 90" FAKE_MODEL_FAIL=1; adopt 4242
unset FAKE_MODEL_FAIL; PROV_RETRY_AT=$((SECONDS - 1)); prov_adopt_retry
expect "gate_class: definitive then pass clears to none" "adopt-pass/none" "$(field provenance.gate)/$(field provenance.gate_class)"
# launch path: refused definitive (unmanifested model) -> launch-refused/definitive; the model is NOT started
reset; export FAKE_OWNER="4242 90" FAKE_MODEL_FAIL=1; start_coder; rc=$?
write_state 4242
expect "gate_class: launch-refused definitive" "1/launch-refused/definitive" "$rc/$(field provenance.gate)/$(field provenance.gate_class)"
expect "gate_class: launch-refused never kills or starts" "" "$(cat "$tmp/reclaims")"
# launch path: refused transient
reset; export FAKE_OWNER="4242 90" FAKE_STAT_FAIL=1; start_coder; rc=$?
write_state 4242
expect "gate_class: launch-refused transient" "1/launch-refused/transient" "$rc/$(field provenance.gate)/$(field provenance.gate_class)"
# launch path: bypass classified, pass is none
reset; export FAKE_OWNER="4242 90" FAKE_MODEL_FAIL=1; PROVENANCE_ENFORCE=0; start_coder; write_state 4242
expect "gate_class: launch-bypass carries the class" "launch-bypass/definitive" "$(field provenance.gate)/$(field provenance.gate_class)"
reset; export FAKE_OWNER="7000 5"; start_coder
expect "gate_class: launch-pass is none" "launch-pass/none" "$(field provenance.gate)/$(field provenance.gate_class)"
# not-run: a state written before any gate is none
reset; export FAKE_OWNER="4242 90"; write_state 4242
expect "gate_class: not-run is none" "not-run/none" "$(field provenance.gate)/$(field provenance.gate_class)"
# the classifier itself
expect "classifier: could not stat" "transient"  "$(prov_reason_class 'could not stat C:\x')"
expect "classifier: timed out"      "transient"  "$(prov_reason_class 'manifest read timed out after 20s')"
expect "classifier: anything else"  "definitive" "$(prov_reason_class 'model not verified: size mismatch')"

[ "$fails" -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
