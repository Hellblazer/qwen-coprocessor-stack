#!/bin/bash
# Offline test for waitup's dead-launch-ssh exit (bead 07i): waitup, extracted from
# keepalive-coprocessor.sh, against a stubbed up() and real background pids.
# Usage: bash scripts/ops/tests/test-keepalive-waitup.sh   (~5 s). Exits non-zero
# if any case is wrong.
set -u
here=$(cd "$(dirname "$0")" && pwd)
ka="$here/../keepalive-coprocessor.sh"
tmp=$(mktemp -d); H=0
trap '[ "$H" -gt 0 ] && kill "$H" 2>/dev/null; rm -rf "$tmp"' EXIT
sed -n '/^waitup(){$/,/^}$/p' "$ka" > "$tmp/fns.sh"
grep -q 'return 2' "$tmp/fns.sh" || { echo "FAIL: waitup block not found in $ka"; exit 1; }
. "$tmp/fns.sh"
WAITUP_SLEEP=0.2
fails=0
expect() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: want $2 got $3"; fails=$((fails+1)); fi; }
UPAT=0; N=0
up() { N=$((N+1)); [ "$UPAT" -gt 0 ] && [ "$N" -ge "$UPAT" ]; }
run() { N=0; UPAT=$1; waitup 1235 "$2"; R=$?; }
sleep 30 & H=$!
run 3 "$H";  expect "held ssh alive, server comes up" "0/3" "$R/$N"
false & D=$!; wait "$D" 2>/dev/null
run 0 "$D";  expect "launch ssh dead, port down: fail fast" "2/2" "$R/$N"
run 2 "$D";  expect "launch ssh dead, a peer's server answers" "0/2" "$R/$N"
run 1 "$D";  expect "already up" "0/1" "$R/$N"
( sleep 0.5 ) & D2=$!
t0=$SECONDS; run 0 "$D2"; expect "launch ssh dies mid-wait" 2 "$R"
[ $((SECONDS - t0)) -le 3 ] && [ "$N" -ge 3 ] || { echo "FAIL mid-wait timing (N=$N)"; fails=$((fails+1)); }
# no pid, or pid 0: the old behaviour, never rc 2 (kill 0 would signal the group)
seq() { command seq 1 3; }
run 0 0;     expect "pid 0 waits the full bound" "1/3" "$R/$N"
run 0 "";    expect "no pid waits the full bound" "1/3" "$R/$N"
[ "$fails" -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
