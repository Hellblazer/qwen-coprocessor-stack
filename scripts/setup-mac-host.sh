#!/usr/bin/env bash
# Build llama.cpp with Metal and download the workhorse Qwen model on the M4 Max.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODELS_DIR="$ROOT/models"

# Override these env vars to swap in a different Qwen quant or repo.
HF_REPO="${HF_REPO:-unsloth/Qwen3.6-27B-GGUF}"
HF_FILE="${HF_FILE:-Qwen3.6-27B-UD-Q6_K_XL.gguf}"
MODEL_PATH="$MODELS_DIR/$HF_FILE"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "[!] This script targets Apple Silicon. For the Linux/Vulkan box use setup-strix-halo.sh"
  exit 1
fi

echo "[*] Checking Homebrew dependencies..."
command -v brew >/dev/null || { echo "[!] Homebrew required: https://brew.sh"; exit 1; }
brew list cmake >/dev/null 2>&1 || brew install cmake
# Hugging Face renamed `huggingface-cli` to `hf`; the old name now errors out.
command -v hf >/dev/null 2>&1 || brew install hf

LLAMA_DIR="${LLAMA_DIR:-$HOME/src/llama.cpp}"
if [ ! -d "$LLAMA_DIR" ]; then
  echo "[*] Cloning llama.cpp -> $LLAMA_DIR"
  mkdir -p "$(dirname "$LLAMA_DIR")"
  git clone https://github.com/ggerganov/llama.cpp "$LLAMA_DIR"
fi
( cd "$LLAMA_DIR" && git pull --ff-only origin master 2>/dev/null || true )

echo "[*] Building llama.cpp with Metal..."
cmake -S "$LLAMA_DIR" -B "$LLAMA_DIR/build" \
  -DGGML_METAL=ON \
  -DLLAMA_BUILD_TESTS=OFF \
  -DCMAKE_BUILD_TYPE=Release
cmake --build "$LLAMA_DIR/build" -j"$(sysctl -n hw.ncpu)" --target llama-server

echo "[*] Resolving model..."
mkdir -p "$MODELS_DIR"
if [ -f "$MODEL_PATH" ]; then
  echo "[+] Already present: $MODEL_PATH ($(du -h "$MODEL_PATH" | cut -f1))"
else
  echo "[*] Downloading $HF_REPO/$HF_FILE -> $MODELS_DIR (~25.6 GB)"
  if ! hf download "$HF_REPO" "$HF_FILE" --local-dir "$MODELS_DIR"; then
    echo
    echo "[!] hf download failed."
    echo "    Verify HF_REPO and HF_FILE — likely candidates:"
    echo "      unsloth/Qwen3.6-27B-GGUF      (UD-Q6_K_XL, UD-Q8_K_XL, Q4_K_M, Q5_K_M, ...)"
    echo "      bartowski/Qwen_Qwen3.6-27B-GGUF"
    echo "      lmstudio-community/Qwen3.6-27B-GGUF"
    echo "    Override with:  HF_REPO=... HF_FILE=... ./scripts/setup-mac-host.sh"
    exit 1
  fi
fi

cat <<EOF

[+] Mac host ready.
    llama-server : $LLAMA_DIR/build/bin/llama-server
    model        : $MODEL_PATH

Next: ./scripts/start-stack.sh
EOF
