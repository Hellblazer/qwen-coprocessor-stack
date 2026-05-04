#!/usr/bin/env bash
# Read the resolved extension list from env, prepend as a CLI flag,
# delegate to the real qwen binary.
exec "$QWEN_REAL_BIN" \
  ${QWEN_AGENT_EXTENSIONS:+--extensions "$QWEN_AGENT_EXTENSIONS"} \
  "$@"
