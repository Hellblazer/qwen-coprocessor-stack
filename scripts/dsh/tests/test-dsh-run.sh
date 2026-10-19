#!/bin/bash
# Offline test for dsh-run.sh, dsh_summary.py and the proxy's startup checks (bead yudq),
# driven with a fake dsh (DSH_BIN) in throwaway git repos -- no network, no real dsh. The
# proxy starts for real but the fake dsh never calls it.
# Usage: /bin/bash scripts/dsh/tests/test-dsh-run.sh   (~10 s). Exits non-zero if any case is wrong.
set -u
here=$(cd "$(dirname "$0")" && pwd -P)
run="$here/../dsh-run.sh"; summ="$here/../dsh_summary.py"
tmp=$(mktemp -d); tmp=$(cd "$tmp" && pwd -P)
# Run dirs must be outside temp (the session can write temp), so they go under ~/.cache.
mkdir -p "$HOME/.cache"; o=$(mktemp -d "$HOME/.cache/dsh-run-test.XXXXXX")
trap 'rm -rf "$tmp" "$o"' EXIT
fails=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got [$2] want [$3]"; fails=$((fails+1)); fi; }
jget() { python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(eval(sys.argv[2]))' "$1" "$2" 2>&1; }

git init -q "$tmp/main"; git -C "$tmp/main" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$tmp/main" worktree add -q --detach "$tmp/wt" HEAD
echo "do the thing" > "$tmp/task.md"
# Fake dsh: records its env, then emits the events file named by FAKE_EVENTS.
cat > "$tmp/fake-dsh" <<'SH'
#!/bin/bash
env > "$FAKE_ENV_OUT"
cat "$FAKE_EVENTS"
exit "${FAKE_RC:-0}"
SH
chmod +x "$tmp/fake-dsh"
cat > "$tmp/good.ndjson" <<'EV'
{"type":"status","phase":"step_end"}
{"type":"status","phase":"step_end"}
{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}
{"type":"final","text":"done"}
EV
printf '123\n"x"\n{"type":"status","phase":"turn_end","reason":"completed"}\n{"type":"final","text":"ok"}\n{"truncated' > "$tmp/odd.ndjson"
export DSH_BIN="$tmp/fake-dsh" FAKE_ENV_OUT="$tmp/env.txt" OPENROUTER_API_KEY=sk-test-secret-123

# 0. An OUTDIR in temp is refused.
out=$(FAKE_EVENTS="$tmp/good.ndjson" "$run" "$tmp/wt" "$tmp/task.md" "$tmp/out0"); check "refuse outdir in temp" "$(jget "$out" '"temp dir" in d["result"]')" True

# 1. A normal run: JSON on stdout, exit 0, and dsh never sees the key.
out=$(DSH_PERMISSION_MODE=danger-full-access FAKE_EVENTS="$tmp/good.ndjson" "$run" "$tmp/wt" "$tmp/task.md" "$o/o1"); rc=$?
check "normal exit" "$rc" 0
check "normal is_error" "$(jget "$out" 'd["is_error"]')" False
check "normal turns" "$(jget "$out" 'd["turns"]')" 2
check "normal outdir" "$(jget "$out" 'd["outdir"]')" "$o/o1"
check "key absent from dsh env" "$(grep -c 'sk-test-secret-123' "$tmp/env.txt")" 0
check "dsh gets dummy key" "$(grep -c '^DSH_PROXY_DUMMY_KEY=via-proxy$' "$tmp/env.txt")" 1
check "mode pinned over caller env" "$(grep -c '^DSH_PERMISSION_MODE=workspace-write$' "$tmp/env.txt")" 1
check "private TMPDIR" "$(grep -c '^TMPDIR=/private/tmp/dsh-tmp\.' "$tmp/env.txt")" 1
check "telemetry off" "$(grep -c '^DSH_TELEMETRY_DISABLED=1$' "$tmp/env.txt")" 1
check "no proxy left" "$(pgrep -f "dsh-pin-proxy.py $tmp/o1" | wc -l | tr -d ' ')" 0

# 2. Odd events (non-dict lines, string reason, truncated tail): still one JSON line.
out=$(FAKE_EVENTS="$tmp/odd.ndjson" "$run" "$tmp/wt" "$tmp/task.md" "$o/o2"); rc=$?
check "odd events parse" "$(jget "$out" 'd["result"]')" ok
check "odd events exit" "$rc" 0

# 3. dsh fails: is_error true, exit 1, JSON still printed.
out=$(FAKE_EVENTS="$tmp/good.ndjson" FAKE_RC=7 "$run" "$tmp/wt" "$tmp/task.md" "$o/o3"); rc=$?
check "dsh rc surfaced" "$(jget "$out" 'd["rc"]')" 7
check "dsh failure exit" "$rc" 1

# 4. Refusals: main checkout, a subdirectory, OUTDIR inside the worktree (no dir left behind).
mkdir -p "$tmp/wt/sub"
out=$("$run" "$tmp/main" "$tmp/task.md"); check "refuse main" "$(jget "$out" '"main checkout" in d["result"]')" True
out=$("$run" "$tmp/wt/sub" "$tmp/task.md"); check "refuse subdir" "$(jget "$out" '"worktree root" in d["result"]')" True
out=$("$run" "$tmp/wt" "$tmp/task.md" "$tmp/wt/out"); check "refuse outdir in wt" "$(jget "$out" '"inside the worktree" in d["result"]')" True
check "no outdir created in wt" "$([ -e "$tmp/wt/out" ] && echo yes || echo no)" no
out=$("$run" "$tmp/wt" "$tmp/task.md" "$tmp/wt"); check "refuse outdir = wt" "$(jget "$out" '"inside the worktree" in d["result"]')" True
out=$("$run" "$tmp/wt" "$tmp/nope.md"); check "missing task file" "$(jget "$out" 'd["is_error"]')" True
out=$("$run" "$tmp/wt" "$tmp/it's \"quoted\".md"); check "quotes in fail JSON" "$(jget "$out" 'd["is_error"]')" True

# 5. Relative task file, and a reused OUTDIR does not carry old usage.
echo '{"usage":{"cost":5.0}}' > "$o/o1/usage.jsonl"
out=$(cd "$tmp" && FAKE_EVENTS="$tmp/good.ndjson" "$run" "$tmp/wt" task.md "$o/o1")
check "relative task file" "$(jget "$out" 'd["is_error"]')" False
check "stale usage cleared" "$(jget "$out" 'd["usage"]["cost"]')" 0.0

# 6. Summary on hostile input: truncated usage line, non-numeric cost, bad rc.
printf '{"usage":{"cost":"lots","input_tokens":5}}\n{"usage":{"cost":0.25}}\n{"usa' > "$tmp/u.jsonl"
out=$(python3 "$summ" "$tmp/good.ndjson" "$tmp/u.jsonl" 0)
check "summary cost" "$(jget "$out" 'd["usage"]["cost"]')" 0.25
check "summary requests" "$(jget "$out" 'd["usage"]["requests"]')" 2
out=$(python3 "$summ" "$tmp/good.ndjson" "$tmp/u.jsonl" notanumber)
check "summary bad rc" "$(jget "$out" 'd["is_error"]')" True

# 7. Proxy refuses to start without a key or with an empty provider pin.
OPENROUTER_API_KEY= python3 "$here/../dsh-pin-proxy.py" "$tmp/pu" "$tmp/pp" 2>/dev/null
check "proxy no key" "$?" 1
DSH_PROVIDER=" , " python3 "$here/../dsh-pin-proxy.py" "$tmp/pu" "$tmp/pp" 2>/dev/null
check "proxy empty pin" "$?" 1

# 8. relay-check: patch, scope (prefix vs exact, new files), and a test that cannot write outside.
rc_py="$here/../relay-check.py"
base=$(git -C "$tmp/wt" rev-parse HEAD)
rmdir "$tmp/wt/sub"; mkdir -p "$tmp/wt/src/foo" "$tmp/wt/src/foobar"
echo a > "$tmp/wt/src/foo/a.txt"; echo b > "$tmp/wt/src/foobar/b.txt"
out=$(python3 "$rc_py" "$tmp/wt" "$base" "$o/r1" "src/foo/")
check "scope prefix is a dir" "$(jget "$out" 'd["outside_scope"]')" "['src/foobar/b.txt']"
check "patch has new files" "$(grep -c '^diff --git' "$o/r1/patch.diff")" 2
out=$(python3 "$rc_py" "$tmp/wt" "$base" "$o/r2" "src/foo/,src/foobar/b.txt" "echo hi > ok.txt; echo x > $HOME/.dsh-relay-escape-test; echo \${OPENROUTER_API_KEY:-unset}")
check "scope exact file" "$(jget "$out" 'd["scope_ok"]')" True
check "test wrote worktree" "$([ -f "$tmp/wt/ok.txt" ] && echo yes || echo no)" yes
check "test could not escape" "$([ -e "$HOME/.dsh-relay-escape-test" ] && echo yes || echo no)" no
rm -f "$HOME/.dsh-relay-escape-test"
check "test has no key" "$(jget "$out" '"unset" in d["test"]["tail"].splitlines() and "sk-test" not in d["test"]["tail"]')" True

git -C "$tmp/main" worktree remove --force "$tmp/wt"
[ "$fails" -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
