# AI providers — swap guide

`packages/ai` is a provider-agnostic layer: application code depends only on
the `ChatModel` / `EmbeddingModel` interfaces (`@kb/ai`'s `types.ts`), never
on any vendor's SDK. Which vendor actually answers a request is decided
entirely by environment variables read once, at boot, by `createAi()`. This
doc is the full reference for that env contract, plus per-provider setup
notes and the migration template for anyone who wants a non-1536-dimension
embedding model.

After changing anything below, run:

```
pnpm ai:check
```

It resolves your config exactly the way the app will, prints which
provider/model/base URL it picked (API key masked), then makes one real
1-token chat completion and one real 1-input embedding call so a bad key,
wrong model name, or unreachable base URL fails loudly here instead of
showing up later as a 500 in the UI.

## Keyless demo mode (the default)

Leave `AI_CHAT_PROVIDER` / `AI_EMBEDDING_PROVIDER` unset, or set them to
`mock`, and the app runs entirely on `MockChatModel` / `MockEmbeddingModel`
— no API key, no network call, fully deterministic. The mock chat model
extracts the latest user message, cites its first few sentences with
`[S#]` markers, and reports token usage estimated with `gpt-tokenizer`. The
mock embedding model hashes each input into a deterministic, L2-normalized
1536-dimension vector (feature hashing, not a real semantic embedding) —
good enough to exercise chunking, storage, and retrieval end to end without
a key, but not a substitute for a real model's embeddings.

## The full env contract

| Variable | Default | Notes |
| --- | --- | --- |
| `AI_CHAT_PROVIDER` | `mock` | `mock \| openai \| groq \| together \| openrouter \| ollama \| custom` |
| `AI_CHAT_MODEL` | `mock-chat` | Exact model ID the provider expects (e.g. `gpt-4.1-mini`) |
| `AI_CHAT_BASE_URL` | provider preset | Required when `AI_CHAT_PROVIDER=custom`; overrides the preset otherwise |
| `AI_CHAT_API_KEY` | — | Overrides the provider's preset key env var (below) and `AI_API_KEY` |
| `AI_CHAT_SUPPORTS_TEMPERATURE` | `true` | Set `false` for models/providers that reject an explicit `temperature` |
| `AI_EMBEDDING_PROVIDER` | `mock` | Same provider list; **not every provider supports embeddings** (see table below) |
| `AI_EMBEDDING_MODEL` | `mock-embedding` | Exact embedding model ID |
| `AI_EMBEDDING_BASE_URL` | provider preset | Required when `AI_EMBEDDING_PROVIDER=custom` |
| `AI_EMBEDDING_API_KEY` | — | Overrides the provider's preset key env var and `AI_API_KEY` |
| `AI_EMBEDDING_DIMENSIONS` | `1536` | **Must stay 1536** unless you run the migration below first |
| `AI_API_KEY` | — | Generic fallback key, tried after the provider-specific env var, before erroring |
| `AI_REQUEST_TIMEOUT_MS` | `60000` | Per-request timeout passed to the HTTP client |
| `AI_MAX_RETRIES` | `2` | Retries for `rate_limit` / `unavailable` / `timeout` errors, full-jitter backoff |

Resolution order for both the base URL and the API key: **explicit
override → provider preset → error.** `AI_CHAT_PROVIDER`/`AI_EMBEDDING_PROVIDER`
resolve independently — you can, for example, run chat on OpenAI and
embeddings on `mock`, or chat on Groq and embeddings on OpenAI (Groq has no
embeddings endpoint at all).

Every problem `resolveAiConfig()` finds — an unknown provider, a missing
key, a missing base URL for `custom`, a non-1536 dimension count — is
collected into **one** error listing every issue at once, not just the
first, so a freshly-misconfigured `.env` can be fixed in a single pass. Run
`pnpm ai:check` to see that message rendered, or just start the app —
`createAi()` throws the same `AiError` (`code: "config"`) at boot.

## Provider presets

| Provider | Base URL | API key env var | Chat | Embeddings | Notes |
| --- | --- | --- | --- | --- | --- |
| `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` | ✅ | ✅ | Get a key at platform.openai.com |
| `groq` | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | ✅ | ❌ | No `/embeddings` route — pick a different `AI_EMBEDDING_PROVIDER` |
| `together` | `https://api.together.ai/v1` | `TOGETHER_API_KEY` | ✅ | ✅ | `.together.ai`, not the older `.together.xyz` |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | ✅ | ✅ | Routes to many underlying models by `AI_CHAT_MODEL` |
| `ollama` | `http://localhost:11434/v1` | — (no key needed) | ✅ | ✅ | Local; run `ollama serve` first, `ollama pull <model>` for whatever `AI_CHAT_MODEL`/`AI_EMBEDDING_MODEL` name |
| `custom` | — (you set it) | none by default | ✅ | ✅ | Any OpenAI-compatible `/chat/completions` + `/embeddings` server — self-hosted, a proxy, an internal gateway |

This table is also `packages/ai/src/presets.ts` in code form — that file is
the source of truth if the two ever drift; it's pure data with no logic, so
adding a new OpenAI-compatible vendor that fits this shape is a one-entry
addition there, no other code changes needed. See `docs/DECISIONS.md` D2.1
for why the Together/OpenRouter rows above differ from the original build
brief (both vendors changed their published details after the brief was
written).

### OpenAI

```
AI_CHAT_PROVIDER=openai
AI_CHAT_MODEL=gpt-4.1-mini
AI_EMBEDDING_PROVIDER=openai
AI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_API_KEY=sk-...
```

### Groq (chat only)

Groq has no embeddings endpoint, so pair it with another provider (or
`mock`) for embeddings:

```
AI_CHAT_PROVIDER=groq
AI_CHAT_MODEL=llama-3.3-70b-versatile
GROQ_API_KEY=gsk_...
AI_EMBEDDING_PROVIDER=openai
AI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_API_KEY=sk-...
```

### Together

```
AI_CHAT_PROVIDER=together
AI_CHAT_MODEL=meta-llama/Llama-3.3-70B-Instruct-Turbo
AI_EMBEDDING_PROVIDER=together
AI_EMBEDDING_MODEL=togethercomputer/m2-bert-80M-8k-retrieval
TOGETHER_API_KEY=...
```

### OpenRouter

```
AI_CHAT_PROVIDER=openrouter
AI_CHAT_MODEL=openai/gpt-4.1-mini
AI_EMBEDDING_PROVIDER=openrouter
AI_EMBEDDING_MODEL=openai/text-embedding-3-small
OPENROUTER_API_KEY=sk-or-...
```

### Ollama (local, no key)

```
ollama serve
ollama pull llama3.1
ollama pull nomic-embed-text
```

```
AI_CHAT_PROVIDER=ollama
AI_CHAT_MODEL=llama3.1
AI_EMBEDDING_PROVIDER=ollama
AI_EMBEDDING_MODEL=nomic-embed-text
```

If `pnpm ai:check` reports `[unavailable] Could not reach Ollama — is
\`ollama serve\` running?`, that's exactly what it means — start the Ollama
daemon and try again.

### Custom (any OpenAI-compatible endpoint)

```
AI_CHAT_PROVIDER=custom
AI_CHAT_BASE_URL=https://my-internal-gateway.example.com/v1
AI_CHAT_MODEL=whatever-that-gateway-calls-it
AI_CHAT_API_KEY=...
```

`custom`'s capabilities default conservatively (`streamUsage: false`,
`embeddingDimensionsParam: false`) since there's no vendor to look up —
usage is always estimated with `gpt-tokenizer` for a `custom` endpoint
unless you fork `presets.ts` to add a proper entry once you know the
endpoint's real behavior.

## Changing `AI_EMBEDDING_DIMENSIONS` away from 1536

`document_chunks.embedding` is declared `vector(1536)` in
`supabase/migrations/20260916233538_init.sql`, and `resolveAiConfig()`
deliberately refuses any other `AI_EMBEDDING_DIMENSIONS` value with an
error naming this doc — pgvector's `vector(N)` column width is fixed at
creation time, so a silent mismatch would only surface as a runtime insert
failure (or worse, a silently-truncated/rejected write) instead of a clear
boot-time config error.

To actually switch embedding dimensions (e.g. moving to a model that
produces 1024-dimension vectors), run a migration altering the column
**before** changing `AI_EMBEDDING_DIMENSIONS`, and re-embed every existing
row — a change in dimension is also almost always a change in embedding
space, so old vectors aren't comparable to new ones even if you skipped the
column change:

```sql
-- supabase/migrations/<timestamp>_resize_embedding_column.sql
begin;

-- Existing HNSW index is built for the old dimension; drop it before the
-- column type change, it will need to be rebuilt for the new one anyway.
drop index if exists document_chunks_embedding_hnsw;

alter table public.document_chunks
  alter column embedding type vector(1024); -- new dimension here

create index document_chunks_embedding_hnsw
  on public.document_chunks
  using hnsw (embedding vector_cosine_ops);

commit;
```

Then:

1. Update `REQUIRED_EMBEDDING_DIMENSIONS` in `packages/ai/src/config.ts` to
   match (this constant, not just the env var, is what `resolveAiConfig()`
   validates against).
2. Set `AI_EMBEDDING_DIMENSIONS` to the new value and point
   `AI_EMBEDDING_PROVIDER`/`AI_EMBEDDING_MODEL` at the model that actually
   produces vectors of that width.
3. Re-embed every existing `document_chunks` row with the new model —
   `replace_document_chunks`'s content-hash guard means re-running the same
   ingestion pipeline against unchanged source documents is a no-op for
   anything already up to date, but a dimension change invalidates the hash
   guard's assumption that "same content hash = same embedding," so this
   one time, force a full re-embed rather than relying on the guard to skip
   unchanged rows.
4. Run `pnpm ai:check` to confirm the new provider/model pair actually
   returns vectors of the width you just migrated to — `embed-model.ts`'s
   own validation will reject a mismatch with an `invalid_response`
   `AiError` if the provider returns something else.

## Verifying a provider is wired up correctly

`pnpm ai:check` (`apps/api/src/cli/ai-check.ts`) is the fast, manual check:
it prints the resolved config (key masked) and makes one real 1-token chat
completion and one real 1-input embedding call, reporting latency, finish
reason, dimensions, and whether usage was provider-reported or estimated.
Automated tests (`pnpm --filter @kb/ai test`) never call a real provider —
they run the shared behavioral contract (`packages/ai/src/contract.ts`)
against both the mock models and the real HTTP adapter stubbed with `msw`,
so CI stays fast, deterministic, and key-free, while `ai:check` is what you
run by hand after actually pointing at a live provider.
