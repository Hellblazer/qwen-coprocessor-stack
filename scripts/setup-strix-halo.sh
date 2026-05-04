#!/usr/bin/env bash
# Setup script for the Strix Halo (AMD Ryzen AI MAX+ 395, gfx1151) Linux
# inference host. Builds llama.cpp with Vulkan support and downloads a
# Qwen GGUF model suited to the 128 GB unified memory.
#
# Recommended distro: Fedora 43 (kernel ≥6.18.6 in default repos) or
# Ubuntu 24.04 LTS with HWE / Ubuntu 26.04. Older distros need a custom
# kernel — not supported by this script.
#
# Path chosen: Vulkan via Mesa RADV. ROCm has open MES-firmware hangs
# under sustained load (kernel cmdline workaround `amdgpu.cwsr_enable=0`)
# that the Vulkan path doesn't trigger. Vulkan is also faster for token
# generation on Qwen 30B-class MoE models (65–87 t/s vs ~40–50 ROCm).
# See docs/rdr/RDR-004 §References for the research summary.
#
# OPERATOR PRECONDITIONS (do these once, by hand):
#   1. BIOS: dedicated VRAM = 512 MB (the rest goes through GTT/UMA).
#      Larger dedicated VRAM steals from the inference pool.
#   2. Kernel cmdline (defensive; harmless on the Vulkan path):
#        sudo grubby --update-kernel=ALL --args='amdgpu.cwsr_enable=0'
#      Only matters if you ever switch to ROCm; safe to set now.
#   3. SSH server enabled with key-based auth from the Mac. Recommended
#      ssh_config on the Mac:
#        Host strix
#          HostName strix.local        # or its LAN IP / Tailscale name
#          User <your-user>
#          ControlMaster auto
#          ControlPersist 10m

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODELS_DIR="${MODELS_DIR:-$ROOT/models}"

HF_REPO="${HF_REPO:-unsloth/Qwen3.6-35B-A3B-GGUF}"
HF_FILE="${HF_FILE:-Qwen3.6-35B-A3B-UD-Q8_K_XL.gguf}"
MODEL_PATH="$MODELS_DIR/$HF_FILE"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "[!] This script targets Linux. For the Mac use setup-mac-host.sh"
  exit 1
fi

echo "[*] Detected Linux $(uname -r)"
KERNEL_VERSION="$(uname -r | cut -d- -f1)"
KERNEL_MAJOR=$(echo "$KERNEL_VERSION" | cut -d. -f1)
KERNEL_MINOR=$(echo "$KERNEL_VERSION" | cut -d. -f2)
if [ "$KERNEL_MAJOR" -lt 6 ] || { [ "$KERNEL_MAJOR" -eq 6 ] && [ "$KERNEL_MINOR" -lt 18 ]; }; then
  echo "[!] Kernel $KERNEL_VERSION is older than 6.18 — Strix Halo gfx1151"
  echo "    support requires ≥6.18.4. Upgrade your kernel before proceeding."
  echo "    Fedora 43 and Ubuntu 24.04 HWE / 26.04 ship a recent enough kernel."
  exit 1
fi

echo "[*] Installing Vulkan and build dependencies..."
if command -v dnf >/dev/null; then
  sudo dnf install -y vulkan-loader vulkan-tools mesa-vulkan-drivers \
    git cmake gcc-c++ python3-pip
elif command -v apt >/dev/null; then
  sudo apt update
  sudo apt install -y vulkan-tools libvulkan1 mesa-vulkan-drivers \
    git cmake build-essential python3-pip
else
  echo "[!] Unknown package manager. Install vulkan-tools, cmake, build-essential manually."
fi

# Confirm RADV exposes the GPU. If this prints CPU (llvmpipe), the GPU is
# not visible to Vulkan and inference will run on CPU only.
echo "[*] Vulkan device(s) visible:"
vulkaninfo --summary 2>/dev/null | grep -E 'deviceName|driverName' | head -10 || true

pip3 install --user --upgrade huggingface_hub

LLAMA_DIR="${LLAMA_DIR:-$HOME/src/llama.cpp}"
if [ ! -d "$LLAMA_DIR" ]; then
  mkdir -p "$(dirname "$LLAMA_DIR")"
  git clone https://github.com/ggerganov/llama.cpp "$LLAMA_DIR"
fi
( cd "$LLAMA_DIR" && git fetch --all --tags && git checkout master && git pull --ff-only origin master )

echo "[*] Building llama.cpp with Vulkan support..."
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
  python3 -m huggingface_hub.commands.huggingface_cli download \
    "$HF_REPO" "$HF_FILE" --local-dir "$MODELS_DIR" || {
    echo "[!] Download failed — verify HF_REPO/HF_FILE."
    exit 1
  }
fi

cat <<EOF

[+] Strix Halo host ready.
    llama-server  : $LLAMA_DIR/build/bin/llama-server
    model         : $MODEL_PATH

Smoke-test the server on this host:

    "$LLAMA_DIR/build/bin/llama-server" \\
      -m "$MODEL_PATH" \\
      --alias qwen3.6-35b-a3b \\
      -ngl 99 \\
      -c 65536 \\
      --cache-type-k q8_0 --cache-type-v q8_0 \\
      --port 8080 --host 0.0.0.0

Then from the Mac, register the host in the supervisor's fleet config (RDR-004):

    [host.strix]
    transport     = "ssh"
    ssh_target    = "<user>@strix.local"
    arch          = "linux-x86_64"
    inference     = "vulkan"
    models_dir    = "$MODELS_DIR"
    llama_bin     = "$LLAMA_DIR/build/bin/llama-server"

Expected throughput on Qwen 30B-class MoE Q4: ~65-87 tokens/sec.
EOF
