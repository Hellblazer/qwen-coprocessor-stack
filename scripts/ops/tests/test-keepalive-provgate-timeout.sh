#!/bin/bash
# Offline test for prov_gate's wall-clock bound on every "$PYTHON" call (bead
# b1y): py_bounded, prov_timeout and prov_gate, extracted from
# keepalive-coprocessor.sh and driven with fake interpreters -- no ssh, no
# network, no real python. The shipped bound is 20 s; PROV_PY_TIMEOUT=2 here
# keeps the two timeout cases quick. bash prints an "Alarm clock: 14" line on
# stderr for those cases: that SIGALRM is the mechanism under test, not a fault.
# Usage: /bin/bash scripts/ops/tests/test-keepalive-provgate-timeout.sh   (~5 s).
# Exits non-zero if any case is wrong.
set -u
here=$(cd "$(dirname "$0")" && pwd)
ka="$here/../keepalive-coprocessor.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
sed -n -e '/^py_bounded() {/,/^}$/p' -e '/^prov_timeout() {/,/^}$/p' -e '/^prov_gate() {/,/^}$/p' "$ka" > "$tmp/fns.sh"
for f in py_bounded prov_timeout prov_gate; do
  grep -q "^$f() {" "$tmp/fns.sh" || { echo "FAIL: $f not found in $ka"; exit 1; }
done
grep -q 'overlay check-path' "$tmp/fns.sh" || { echo "FAIL: prov_gate block truncated"; exit 1; }
# Fake interpreters. The sleeper records its own pid and then REPLACES itself with
# the sleep (exec keeps the pid), so the pid on file is exactly the hung process.
cat > "$tmp/py-ok" <<'PY'
#!/bin/bash
echo "n=1"
PY
cat > "$tmp/py-fail" <<'PY'
#!/bin/bash
echo "boom" >&2
exit 3
PY
cat > "$tmp/py-sleep" <<PY
#!/bin/bash
echo \$\$ > "$tmp/sleep.pid"
exec sleep 30
PY
cat > "$tmp/py-empty" <<'PY'
#!/bin/bash
echo 0
PY
chmod +x "$tmp/py-ok" "$tmp/py-fail" "$tmp/py-sleep" "$tmp/py-empty"
REPO_DIR="$tmp/repo"; mkdir -p "$REPO_DIR/models" "$REPO_DIR/scripts/ops/provenance"
printf '{"artifacts": [{"id": "x"}]}' > "$REPO_DIR/models/MANIFEST.json"
PROV="$REPO_DIR/scripts/ops/provenance/provenance.py"; : > "$PROV"
PROV_PY_TIMEOUT=2
PYTHON="$tmp/py-ok"
. "$tmp/fns.sh"
# boxlen is never reached by these cases (the gate returns before the stat, or the
# manifest is empty); log's line is not the assertion. Both are stubbed.
log() { :; }
boxlen() { echo 12345; }
fails=0
expect() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: want $2 got $3"; fails=$((fails+1)); fi; }
# 1: in-time python -- stdout and status pass through untouched
PYTHON="$tmp/py-ok"
out=$(py_bounded -c 'ignored'); rc=$?
expect "py_bounded passes stdout and status through" "$rc/$out" "0/n=1"
# 2: python's own failure -- status and stderr both intact
PYTHON="$tmp/py-fail"
err=$(py_bounded 2>&1 1>/dev/null); rc=$?
expect "py_bounded keeps python's own status and stderr" "$rc/$err" "3/boom"
# 3: python hangs -- bounded, 124, and the hung process is really gone
PYTHON="$tmp/py-sleep"; rm -f "$tmp/sleep.pid"
t0=$SECONDS; out=$(py_bounded 2>/dev/null); rc=$?; el=$((SECONDS - t0)); sp=$(cat "$tmp/sleep.pid" 2>/dev/null)
expect "py_bounded bounds the hang at 124" "$rc" "124"
[ "$el" -le 6 ] && echo "ok   hang returned in ${el}s (<= 6)" || { echo "FAIL hang took ${el}s"; fails=$((fails+1)); }
if [ -z "$sp" ]; then echo "FAIL fake python never recorded its pid"; fails=$((fails+1))
elif kill -0 "$sp" 2>/dev/null; then echo "FAIL sleeping fake python (pid $sp) still alive"; fails=$((fails+1))
else echo "ok   hung fake python is gone (pid $sp)"; fi
# 4: prov_gate on a hanging python -- refusal naming manifest read + the TCC cause
rm -f "$tmp/sleep.pid"; PROV_REASON=""
prov_gate; rc=$?
case "$PROV_REASON" in
  *"manifest read timed out"*Python.app*) rr=ok ;;
  *) rr="reason was '${PROV_REASON:-<empty>}'" ;;
esac
expect "prov_gate refuses with the manifest-read timeout reason" "$rc/$rr" "1/ok"
# 5: the same bound on a check-path call site (the `|| { pyrc=$?; ... }` shape):
# a python that answers the manifest read and then hangs on check-path.
cat > "$tmp/py-sleep-on-checkpath" <<PY
#!/bin/bash
case "\$*" in
  *check-path*) echo \$\$ > "$tmp/sleep.pid"; exec sleep 30 ;;
  *) echo 1 ;;
esac
PY
chmod +x "$tmp/py-sleep-on-checkpath"
PYTHON="$tmp/py-sleep-on-checkpath"; CODER_MODEL='D:\models\x.gguf'; rm -f "$tmp/sleep.pid"; PROV_REASON=""
prov_gate; rc=$?
case "$PROV_REASON" in
  *"model check-path timed out"*Python.app*) rr=ok ;;
  *) rr="reason was '${PROV_REASON:-<empty>}'" ;;
esac
expect "prov_gate names the model check-path timeout" "$rc/$rr" "1/ok"
# 6: in-time empty manifest -- unchanged: armed-to-unarmed bootstrap path
PYTHON="$tmp/py-empty"; PROV_REASON=""
prov_gate; rc=$?
expect "prov_gate empty-manifest path unchanged" "$rc/$PROV_MODEL_ID" "0/unarmed:empty-manifest"
# 7: a fast FAILING python still gets the generic reason, not the timeout one
PYTHON="$tmp/py-fail"; PROV_REASON=""
prov_gate; rc=$?
case "$PROV_REASON" in
  *"manifest unreadable"*) rr=ok ;;
  *) rr="reason was '${PROV_REASON:-<empty>}'" ;;
esac
expect "non-timeout failure keeps the generic reason" "$rc/$rr" "1/ok"
[ "$fails" -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
