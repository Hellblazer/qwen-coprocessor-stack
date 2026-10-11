#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# RDR-016: sample-command test runner for provenance-guard.sh. No framework
# (bash 3.2 compatible, matches the hook script itself). Feeds each sample
# command through the hook as a PreToolUse hook payload, asserts the
# resulting decision (allow / ask / deny). Run:
#
#   bash plugins/qwen-stack/hooks/tests/test-provenance-guard.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../provenance-guard.sh"

PASS=0
FAIL=0

# Each entry: "expected_decision~~~description~~~command"
# expected_decision is one of: allow ask deny
TESTS=(
    # --- deny: raw Hugging Face acquisition ---
    "deny~~~hf download~~~hf download Qwen/Qwen3.8-27B"
    "deny~~~hf download, double space (code-review 2026-08-15 repro)~~~hf  download Qwen/Qwen3.8-27B"
    "deny~~~huggingface-cli download~~~huggingface-cli download Qwen/Qwen3.8-27B"
    "deny~~~huggingface-cli download, double space~~~huggingface-cli  download Qwen/Qwen3.8-27B"
    "deny~~~snapshot_download(~~~python3 -c \"from huggingface_hub import snapshot_download; snapshot_download('Qwen/Qwen3.8-27B')\""
    "deny~~~hf_hub_download(~~~python3 -c \"from huggingface_hub import hf_hub_download; hf_hub_download('Qwen/Qwen3.8-27B', 'x')\""
    "deny~~~snapshot_download aliased import (code-review 2026-08-15 repro)~~~python3 -c \"from huggingface_hub import snapshot_download as sd; sd(repo_id='Qwen/Qwen3.8-27B')\""
    "deny~~~hf_hub_download aliased import~~~python3 -c \"from huggingface_hub import hf_hub_download as dl; dl(repo_id='Qwen/Qwen3.8-27B', filename='x')\""
    "deny~~~HfApi aliased import~~~python3 -c \"from huggingface_hub import HfApi as Api; Api().upload_file()\""
    "deny~~~huggingface_hub.snapshot_download dotted access~~~python3 -c \"import huggingface_hub; huggingface_hub.snapshot_download('Qwen/Qwen3.8-27B')\""
    "deny~~~huggingface_hub.hf_hub_download dotted access~~~python3 -c \"import huggingface_hub; huggingface_hub.hf_hub_download('Qwen/Qwen3.8-27B', 'x')\""
    "deny~~~git clone huggingface.co~~~git clone https://huggingface.co/Qwen/Qwen3.8-27B"
    "deny~~~git lfs pull huggingface.co~~~git lfs pull https://huggingface.co/Qwen/Qwen3.8-27B"
    "deny~~~curl huggingface.co non-api~~~curl -O https://huggingface.co/Qwen/Qwen3.8-27B/resolve/main/model.safetensors"
    "deny~~~wget hf.co non-api~~~wget https://hf.co/Qwen/Qwen3.8-27B/resolve/main/model.safetensors"
    "deny~~~ollama pull~~~ollama pull qwen3.8:27b"
    "deny~~~ollama pull, double space~~~ollama  pull qwen3.8:27b"
    "deny~~~ollama run (pull side effect)~~~ollama run qwen3.8:27b"
    "deny~~~lms get~~~lms get qwen/qwen3.8-27b-gguf"
    "deny~~~lms get, double space~~~lms  get qwen/qwen3.8-27b-gguf"
    # --- deny: raw runtime acquisition ---
    "deny~~~gh release download llama.cpp~~~gh release download b10078 --repo ggml-org/llama.cpp"
    "deny~~~gh release download llama.cpp, double space~~~gh release  download b10078 --repo ggml-org/llama.cpp"
    "deny~~~curl github release asset~~~curl -L -O https://github.com/ggml-org/llama.cpp/releases/download/b10078/llama-b10078-bin-win-vulkan-x64.zip"
    # --- deny: unverified transfer to the box ---
    "deny~~~scp gguf to box~~~scp Qwen3.8-27B-Q6_K.gguf qwentescence:D:/models/"
    "deny~~~rsync mmproj to box~~~rsync -av mmproj-Qwen3.8.gguf user@qwentescence:D:/models/"
    # --- deny: pickle formats ---
    "deny~~~torch.load without weights_only~~~python3 -c \"import torch; torch.load('model.bin')\""
    "deny~~~--model pickle ext~~~llama-server --model /models/legacy/model.bin --port 1235"
    "deny~~~-m pickle ext (short flag)~~~llama-server -m /models/legacy/model.pt --port 1235"
    "deny~~~--mmproj pickle ext~~~llama-server --model x.gguf --mmproj mmproj-legacy.pth"
    "deny~~~from_pretrained pickle path~~~python3 -c \"from transformers import AutoModel; AutoModel.from_pretrained('foo/bar.bin')\""
    "deny~~~trust_remote_code=True~~~python3 -c \"from transformers import AutoModel; AutoModel.from_pretrained('foo/bar', trust_remote_code=True)\""
    "deny~~~--trust-remote-code flag~~~python3 run.py --trust-remote-code"
    # --- ask: documented escape hatch ---
    "ask~~~QWEN_PROVENANCE_ENFORCE=0 escape hatch~~~QWEN_PROVENANCE_ENFORCE=0 hf download Qwen/Qwen3.8-27B"
    # --- allow: sanctioned tool / read-only / unrelated commands ---
    "allow~~~sanctioned fetch~~~python3 scripts/ops/provenance/provenance.py fetch Qwen/Qwen3.8-27B"
    "allow~~~sanctioned fetch, cwd-prefixed~~~cd /Volumes/Transcend\\ Hell/git/qwen-coprocessor-stack && python3 scripts/ops/provenance/provenance.py fetch Qwen/Qwen3.8-27B"
    # --- fetch rules match a command, not a mention (2026-10-11 over-match) ---
    "allow~~~curl of another project's release asset~~~curl -L -o e.tgz https://github.com/Hellblazer/nexus/releases/download/engine-service-v0.1.159/engine.tgz"
    "allow~~~actions runner release over ssh (labrun, 2026-10-10)~~~ssh chas 'set -e; [ -f ar.tgz ] || { curl -fsSLo ar.tgz https://github.com/actions/runner/releases/download/v2.338.0/actions-runner-linux-x64-2.338.0.tar.gz; }'"
    "allow~~~wget uv release~~~gh release view; wget https://github.com/astral-sh/uv/releases/download/0.9.0/uv.tar.gz"
    "allow~~~health check, then a commit message naming HF~~~curl -s http://localhost:8080/health && git commit -m \"docs: mention huggingface.co\""
    "allow~~~grep for curl and an HF hostname~~~grep -rn \"curl\" docs/ | grep huggingface.co"
    "allow~~~words containing curl and hf.co~~~echo curly; cat notes-on-hf.co.txt"
    "allow~~~plain curl~~~curl -s http://qwentescence:1235/health"
    "deny~~~curl HF behind env, path and sudo~~~HF_TOKEN=x sudo /usr/bin/curl -LO https://huggingface.co/Qwen/Qwen3.8-27B/resolve/main/model.safetensors"
    "deny~~~curl HF after && inside ssh quotes~~~ssh box 'cd /tmp && curl -LO https://cdn-lfs.huggingface.co/repos/ab/cd/model.gguf'"
    "deny~~~curl HF in a brace group~~~[ -f m.gguf ] || { curl -LO https://hf.co/Qwen/x/resolve/main/m.gguf; }"
    "deny~~~curl HF with line continuation~~~curl -L \\
  -o m.gguf https://huggingface.co/Qwen/x/resolve/main/m.gguf"
    "deny~~~wget ollama release~~~wget https://github.com/ollama/ollama/releases/download/v0.9.0/ollama-darwin.tgz"
    "deny~~~xargs curl llama.cpp fork release~~~echo u | xargs curl -LO https://github.com/someone/llama.cpp-fork/releases/download/b1/x.zip"
    "allow~~~HF api metadata read~~~curl -s https://huggingface.co/api/models/Qwen/Qwen3.8-27B"
    "allow~~~git status~~~git status"
    "allow~~~npm run build~~~npm run build"
    "allow~~~PROVENANCE_TRANSFER=1 scp~~~PROVENANCE_TRANSFER=1 scp foo.gguf qwentescence:D:/models/"
    "allow~~~ssh to box, no transfer~~~ssh qwentescence dir D:\\\\models"
    "allow~~~scp of a .ps1 with a .gguf mentioned on ANOTHER line (compound command)~~~scp -q scripts/ops/win/Get-ProvenanceCheckPath.ps1 qwentescence:D:/claude-coordination/ && cat > x.ps1 <<'EOF'
& D:\\\\claude-coordination\\\\Get-ProvenanceCheckPath.ps1 -Path 'D:\\\\models\\\\Qwen3-Coder-Next-UD-Q4_K_XL.gguf'
EOF"
    "deny~~~scp gguf to box on a later line of a compound command~~~echo hi
scp Qwen3.8-27B-Q6_K.gguf qwentescence:D:/models/"
    "allow~~~pip show huggingface_hub (unrelated, no API call)~~~pip show huggingface_hub"
    "allow~~~import huggingface_hub with no dotted call (regression check)~~~python3 -c \"import huggingface_hub; print(huggingface_hub.__version__)\""
)

# Build a PreToolUse hook payload and run the hook, printing its decision
# ("allow" when it produced no deny/ask output, else the JSON decision).
run_case() {
    command="$1"
    payload="$(python3 -c '
import json, sys
sys.stdout.write(json.dumps({"tool_name": "Bash", "tool_input": {"command": sys.argv[1]}}))
' "$command")"

    output="$(printf '%s' "$payload" | bash "$HOOK" 2>/dev/null)"

    if [ -z "$output" ]; then
        echo "allow"
        return
    fi

    printf '%s' "$output" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    print(data["hookSpecificOutput"]["permissionDecision"])
except Exception:
    print("UNPARSEABLE")
'
}

for entry in "${TESTS[@]}"; do
    expected="${entry%%~~~*}"
    rest="${entry#*~~~}"
    description="${rest%%~~~*}"
    command="${rest#*~~~}"

    actual="$(run_case "$command")"

    if [ "$actual" = "$expected" ]; then
        PASS=$((PASS + 1))
        echo "PASS  [$expected] $description"
    else
        FAIL=$((FAIL + 1))
        echo "FAIL  [$expected -> $actual] $description"
        echo "      command: $command"
    fi
done

echo ""
echo "$PASS passed, $FAIL failed (of $((PASS + FAIL)))"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
