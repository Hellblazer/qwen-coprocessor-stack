@echo off
REM launch-llama.cmd — scheduled-task entrypoint. cmd.exe redirection captures
REM native-exe stdout/stderr cleanly; PowerShell 1>/2> does not.
REM
REM Tuning history:
REM   2026-05-09 v1: --mlock, ctx 65536, --threads 16, --flash-attn 1
REM   2026-05-09 v2: ctx 131072 (128K)
REM   2026-05-09 v3: KV cache q8_0 (halved memory), prompt cache 32 GB,
REM                  cache-reuse 32 (aggressive prefix matching),
REM                  kv-unified (enable cache-idle-slots cross-slot residency).

if exist D:\llama\server.log move /Y D:\llama\server.log D:\llama\server.log.prev > /dev/null 2>&1
if exist D:\llama\server.err move /Y D:\llama\server.err D:\llama\server.err.prev > /dev/null 2>&1

D:\llama\llama-server.exe ^
  -m D:\models\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf ^
  --host 0.0.0.0 ^
  --port 1234 ^
  --n-gpu-layers 99 ^
  --ctx-size 131072 ^
  --flash-attn 1 ^
  --mlock ^
  --threads 16 ^
  --cache-type-k q8_0 ^
  --cache-type-v q8_0 ^
  --cache-ram 32768 ^
  --cache-reuse 32 ^
  --kv-unified ^
  --alias qwen3.6-35b-a3b ^
  > D:\llama\server.log 2> D:\llama\server.err
