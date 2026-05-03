#!/usr/bin/env bash
# ASPIRATIONAL — for an AMD Strix Halo Linux box that does not exist yet.
# Builds llama.cpp with Vulkan and downloads the heavier Qwen3.6-35B-A3B MoE.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODELS_DIR="$ROOT/models"

HF_REPO="${HF_REPO:-unsloth/Qwen3.6-35B-A3B-GGUF}"
HF_FILE="${HF_FILE:-Qwen3.6-35B-A3B-UD-Q8_K_XL.gguf}"
MODEL_PATH="$MODELS_DIR/$HF_FILE"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "[!] This script targets Linux. For the Mac use setup-mac-host.sh"
  exit 1
fi

echo "[*] Installing Vulkan/build dependencies..."
if command -v dnf >/dev/null; then
  sudo dnf install -y vulkan-loader vulkan-tools mesa-vulkan-drivers git cmake gcc-c++ python3-pip
elif command -v apt >/dev/null; then
  sudo apt update
  sudo apt install -y vulkan-tools libvulkan1 mesa-vulkan-drivers git cmake build-essential python3-pip
else
  echo "[!] Unknown package manager. Install vulkan-tools, cmake, build-essential manually."
fi
pip3 install --user --upgrade huggingface_hub

LLAMA_DIR="${LLAMA_DIR:-$HOME/src/llama.cpp}"
if [ ! -d "$LLAMA_DIR" ]; then
  mkdir -p "$(dirname "$LLAMA_DIR")"
  git clone https://github.com/ggerganov/llama.cpp "$LLAMA_DIR"
fi
( cd "$LLAMA_DIR" && git pull --ff-only origin master 2>/dev/null || true )

echo "[*] Building llama.cpp with Vulkan..."
cmake -S "$LLAMA_DIR" -B "$LLAMA_DIR/build" \
  -DGGML_VULKAN=ON \
  -DGGML_CPU_ALL_VARIANTS=ON \
  -DLLAMA_BUILD_TESTS=OFF \
  -DCMAKE_BUILD_TYPE=Release
cmake --build "$LLAMA_DIR/build" -j"$(nproc)" --target llama-server

mkdir -p "$MODELS_DIR"
if [ -f "$MODEL_PATH" ]; then
  echo "[+] Already present: $MODEL_PATH ($(du -h "$MODEL_PATH" | cut -f1))"
else
  echo "[*] Downloading $HF_REPO/$HF_FILE -> $MODELS_DIR (~40 GB)"
  python3 -m huggingface_hub.commands.huggingface_cli download "$HF_REPO" "$HF_FILE" --local-dir "$MODELS_DIR" || {
    echo "[!] Download failed — verify HF_REPO/HF_FILE."; exit 1; }
fi

cat <<EOF

[+] Strix Halo host ready.
    llama-server : $LLAMA_DIR/build/bin/llama-server
    model        : $MODEL_PATH

Run llama-server bound to 0.0.0.0:8080 and ensure strix-halo.local resolves
from the Mac (check QWEN_REMOTE_BASE_URL in your .env).
EOF
