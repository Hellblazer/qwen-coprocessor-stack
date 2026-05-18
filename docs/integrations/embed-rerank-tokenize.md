# qwen_embed / qwen_rerank / qwen_tokenize

Three llama-server endpoints surfaced as supervisor MCP tools in v0.11
(PR #9, bd qwen-coprocessor-stack-q42). All three bypass `@qwen-code/sdk`
(text-chat only) and POST directly to llama-server, same pattern as
`qwen_oneshot_vision`.

| Tool | Endpoint | Routing |
|---|---|---|
| `qwen_embed` | `POST /v1/embeddings` | requires a backend with `modality: "embedding"` |
| `qwen_rerank` | `POST /v1/rerank` | requires a backend with `modality: "rerank"` |
| `qwen_tokenize` | `POST /tokenize` | any healthy text/multimodal backend |

## Backend modality

Operator-declared per backend in `~/.qwen-coprocessor-stack/config.json`.
The supervisor hot-reloads this file on each tool request — no restart
needed when adding or retargeting backends.

Modality values: `"text"` (default when unset), `"multimodal"`,
`"embedding"`, `"rerank"`.

## Minimal end-to-end setup

### 1. Fetch the GGUFs

Defaults below match what `scripts/start-embed-server.sh` and
`scripts/start-rerank-server.sh` expect. Override via env vars
(`EMBED_FILE=…`, `RERANK_FILE=…`) if you already have other models on
disk.

```bash
cd "$(git rev-parse --show-toplevel)"

# Embeddings — bge-m3, multilingual, 1024-dim, ~1.1GB at Q8
hf download gpustack/bge-m3-GGUF \
  bge-m3-Q8_0.gguf --local-dir models

# Reranking — bge-reranker-v2-m3, cross-encoder, ~600MB at Q8
hf download gpustack/bge-reranker-v2-m3-GGUF \
  bge-reranker-v2-m3-Q8_0.gguf --local-dir models
```

Other reasonable options:

- Embed: `qwen3-embedding-0.6b` (smaller, English-centric)
- Embed: `nomic-embed-text-v1.5` (768-dim, often best-in-class for English RAG)
- Rerank: `qwen3-reranker-0.6b` (paired with qwen3-embedding-0.6b)

### 2. Start the auxiliary servers

```bash
scripts/start-embed-server.sh    # :8081
scripts/start-rerank-server.sh   # :8082
```

Both coexist with the main chat llama-server on :8080 — separate
processes, separate PID files, separate logs in `logs/gpu/`. Stop all
three with `scripts/stop-stack.sh`.

### 3. Declare the backends to the supervisor

Append to the `backends` array in `~/.qwen-coprocessor-stack/config.json`:

```json
{
  "backends": [
    {
      "id": "local-27b",
      "url": "http://localhost:8080/v1",
      "model": "qwen3.6-27b-instruct",
      "tier": "local",
      "capacity": "fast",
      "modality": "multimodal"
    },
    {
      "id": "embed-local",
      "url": "http://localhost:8081/v1",
      "model": "bge-m3",
      "tier": "local",
      "capacity": "fast",
      "modality": "embedding"
    },
    {
      "id": "rerank-local",
      "url": "http://localhost:8082/v1",
      "model": "bge-reranker-v2-m3",
      "tier": "local",
      "capacity": "fast",
      "modality": "rerank"
    }
  ]
}
```

The supervisor reloads this on the next MCP call — no restart.

### 4. Verify via `qwen_backends`

```bash
# From any MCP client (Claude Code, qwen CLI with the nx extension, …):
qwen_backends
```

You should see all three entries with the right `modality` fields and
`healthy: true`.

## Direct curl smoke tests

If the supervisor wrapper isn't behaving, test the underlying servers
in isolation:

```bash
# Embeddings — expect a 1024-element array
curl -s http://localhost:8081/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"bge-m3","input":"hello world"}' \
  | jq '.data[0].embedding | length'

# Reranking — expect relevance_score descending
curl -s http://localhost:8082/v1/rerank \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"bge-reranker-v2-m3",
    "query":"what is a panda?",
    "documents":["pancakes are fluffy","the giant panda is a bear"]
  }' | jq

# Tokenize — hits the chat server, no /v1 prefix
curl -s http://localhost:8080/tokenize \
  -H 'Content-Type: application/json' \
  -d '{"content":"hello world"}' \
  | jq '.tokens | length'
```

## Calling the tools

### `qwen_embed`

```json
{
  "texts": ["the quick brown fox", "jumps over the lazy dog"],
  "opts": { "timeout_ms": 30000 }
}
```

Returns `embeddings: number[][]` in input order. Auto-routes to the
first healthy `modality: "embedding"` backend; pin via `opts.backend`.

### `qwen_rerank`

```json
{
  "query": "what is a panda?",
  "documents": [
    "the giant panda is a bear",
    "pancakes are a breakfast food",
    "panda diplomacy is China's practice of gifting pandas"
  ],
  "opts": { "top_n": 2, "return_documents": true }
}
```

Returns `results` sorted by `relevance_score` desc, each with the
original `index`. With `return_documents: true`, each result includes
the document text.

### `qwen_tokenize`

```json
{
  "content": "The quick brown fox jumps over the lazy dog.",
  "opts": { "add_special": false }
}
```

Returns `tokens: number[]` and `count: number`. Routes to any healthy
text/multimodal backend (the tokenizer is colocated with whatever model
is loaded — embed/rerank servers are excluded since their tokenizer
endpoint may be disabled depending on llama-server build flags).

## Failure modes

| `error.code` | Meaning |
|---|---|
| `backend_error` | HTTP non-2xx, network error, or no matching backend in pool |
| `wrong_modality` | Pinned backend (via `opts.backend`) has the wrong declared modality |
| `timeout` | Request aborted after `opts.timeout_ms` |
| `no_data` (embed) | Response had no `data[]`, or count mismatch with input |
| `no_results` (rerank) | Response had empty `results[]` |
| `no_tokens` (tokenize) | Response had no `tokens` field |

All are envelope errors — the tool always returns a `{ok, error?, …}`
shape; it never throws.

## Progress notifications

`qwen_oneshot` and `qwen_oneshot_vision` now emit MCP
`notifications/progress` events when the client includes a
`_meta.progressToken` on the request:

- `qwen_oneshot`: one event per retry attempt, with
  `progress=N-1, total=max_attempts, message="attempt N/M: spawning"`.
- `qwen_oneshot_vision`: start + end events
  (`progress=0/1: dispatching to <backend>`, then
  `progress=1/1: done` or `…error: <code>`).

Clients that don't supply a progressToken see no behavioral change.

## Performance notes

- `bge-m3` Q8 on M4 Max Metal: ~300 docs/sec batch, ~2ms single.
- `bge-reranker-v2-m3` Q8: ~200 query-doc pairs/sec batch.
- Both fit comfortably alongside the 27B chat server's working set —
  context windows are tiny (8K) and the models themselves are 1–2GB.
- Both auxiliary servers can share GPU with the chat server on a
  single-GPU host, since they're idle most of the time.
