#!/usr/bin/env bash
# Validate the stack end-to-end WITHOUT the workhorse model.
#
# Exercises:
#   - .env presence and required keys
#   - YAML / Python / Bash parsers
#   - docker compose schema
#   - LiteLLM container startup (loads config + imports router.py)
#   - /health/liveliness and /v1/models from the proxy
#   - Router heuristic self-tests inside the container
#
# Does NOT:
#   - Build llama.cpp
#   - Download any model weights
#   - Make a real /v1/messages completion call
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

step() { printf "\n=== %s ===\n" "$1"; }
fail() { printf "[!] %s\n" "$*" >&2; exit 1; }

step "0. Static checks"
[ -f .env ] || fail ".env missing — copy .env.example and edit."
# shellcheck disable=SC1091
set -a; . ./.env; set +a
[ -n "${LITELLM_MASTER_KEY:-}" ] || fail "LITELLM_MASTER_KEY is empty in .env"
[ "${LITELLM_MASTER_KEY}" != "sk-local-CHANGE-ME" ] || fail "LITELLM_MASTER_KEY still placeholder. Pick a real value."

for s in scripts/*.sh claude-code/env.sh; do bash -n "$s" || fail "$s failed bash parse"; done
echo "[+] all shell scripts parse"
python3 -c "import ast; ast.parse(open('config/router.py').read())" || fail "config/router.py syntax"
echo "[+] router.py parses"
docker compose config --quiet || fail "docker-compose.yml schema"
echo "[+] docker compose config valid"

step "1. Start LiteLLM proxy (no llama-server)"
docker compose up -d litellm-proxy

printf "[*] Waiting for LiteLLM /health/liveliness "
for i in {1..30}; do
  if curl -sf http://localhost:4000/health/liveliness >/dev/null; then echo "ok"; break; fi
  printf "."
  if [ "$i" -eq 30 ]; then
    echo " FAIL"
    docker logs --tail 80 qwen-coprocessor-proxy
    fail "LiteLLM did not come up."
  fi
  sleep 2
done

step "2. /v1/models surfaces all four routes"
MODELS_JSON="$(curl -sS http://localhost:4000/v1/models -H "Authorization: Bearer ${LITELLM_MASTER_KEY}")"
echo "$MODELS_JSON" | python3 -m json.tool >/dev/null || fail "non-JSON response: $MODELS_JSON"
for route in claude-qwen-coding claude-qwen-remote claude-escalation claude-router-auto; do
  echo "$MODELS_JSON" | grep -q "\"$route\"" || fail "/v1/models missing $route"
  echo "  [+] $route present"
done

step "3. Router heuristic self-tests (in container)"
docker compose exec -T litellm-proxy python /app/router.py || fail "router.py self-tests failed"

step "4. Backend reachability snapshot"
echo "[*] Local Qwen at $QWEN_LOCAL_BASE_URL:"
if curl -sf -m 3 "${QWEN_LOCAL_BASE_URL%/v1}/health" >/dev/null; then
  echo "    [+] reachable"
else
  echo "    [-] unreachable (expected — workhorse not started)"
fi
echo "[*] Remote Qwen at $QWEN_REMOTE_BASE_URL:"
if curl -sf -m 3 "${QWEN_REMOTE_BASE_URL%/v1}/health" >/dev/null; then
  echo "    [+] reachable"
else
  echo "    [-] unreachable (expected — Strix Halo aspirational)"
fi
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "[*] Anthropic API key present — escalation route available."
else
  echo "[-] ANTHROPIC_API_KEY blank — escalation will collapse to local."
fi

step "5. Tear down"
docker compose down --remove-orphans

cat <<EOF

[+] Dry run PASSED.

The stack's wiring is good. To go live:
  ./scripts/setup-mac-host.sh    # ~22 GB download, builds llama.cpp Metal
  ./scripts/start-stack.sh
EOF
