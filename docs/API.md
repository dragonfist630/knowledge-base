# API Reference

Every route `apps/api` actually exposes, documented from the real
controllers, DTOs, and error-handling code — not a spec written ahead of
the implementation. There is no global path prefix: routes are mounted
exactly where shown below (e.g. `POST /chat`, not `POST /api/chat`).

## Conventions that apply to every route

**Auth.** Every route requires `Authorization: Bearer <supabase-jwt>`
except the two marked `Public` below. A missing/malformed header, or a
token that fails verification, or a token whose `role` claim isn't exactly
`authenticated` (rejects `service_role`/`anon` tokens outright), returns
`401`. See `docs/ARCHITECTURE.md`'s Auth boundary section for the
verification mechanics.

**Rate limiting.** Two buckets, applied per authenticated user (per-IP for
the two public routes): `default` — 120 requests / 60s
(`THROTTLE_DEFAULT_LIMIT`/`THROTTLE_DEFAULT_TTL_MS`) — applies to every
route unless noted otherwise; `chat` — 20 requests / 60s
(`THROTTLE_CHAT_LIMIT`/`THROTTLE_CHAT_TTL_MS`) — applies only to
`POST /chat` and `POST /chat/stream`, and the two routes share one counter.
Exceeding a bucket returns `429`. Both are configurable via env vars; see
`.env.example`. **Caveat**: rate-limit counters are in-memory per process
(no shared store is configured) — see `docs/SCALING.md`.

**Validation.** Every request body/query/param is validated against a Zod
schema from `@kb/shared` — there is no Nest `ValidationPipe`, validation is
entirely explicit per route. A validation failure returns `400` in the
error shape below, with `fieldErrors` populated.

**Error shape.** Every error response, from every route, is:

```ts
{
  requestId: string,       // also echoed as the x-request-id response header
  code: string,
  message: string,
  fieldErrors?: { path: string, message: string }[]   // only for validation_error
}
```

`code` and the HTTP status are derived in this order: a Zod validation
failure → `400 validation_error`; an `AiError` from the AI provider layer →
`429` (`ai_rate_limit`), `504` (`ai_timeout`), or `502` for anything else
(`ai_<code>`); a recognized Postgres/PostgREST error code → `404`
(`db_P0002`, e.g. "document not found" raised inside a function; also
`PGRST116`, a `.single()` query that found 0 or >1 rows), `409`
(`db_23505`, unique violation), or `403` (`db_42501`, an RLS/privilege
block); a Nest `HttpException` (`NotFoundException`, `ConflictException`,
`ThrottlerException`, etc.) → its own status; anything else (truly
unexpected) → `500 internal_error`, with the real message/stack logged
server-side only — never returned to the client.

**CORS.** Allowed only from the single configured `WEB_ORIGIN`
(default `http://localhost:3000`), credentials included.

---

## Meta

### `GET /health` — Public

Liveness check. No auth, no rate-limit bucket beyond `default`-by-IP.

**Response `200`**: `{ status: "ok" }`. No error cases beyond a possible
`429`.

### `GET /meta/ai` — Public

Returns which AI providers are configured, for the frontend's provider
badge — safe to call before sign-in, never includes a raw API key.

**Response `200`**:

```ts
{
  chat: { provider: string, model: string, baseUrl: string, apiKeyMasked: string | undefined },
  embedding: { provider: string, model: string, baseUrl: string, apiKeyMasked: string | undefined, dimensions: number }
}
```

`apiKeyMasked` is either `undefined`, `"xxxx...yyyy"` (first/last 4 chars),
or all `*` for a key ≤8 characters — the real key is never returned.

---

## Documents

### `GET /documents`

**Query**: `{ q?: string (1–200 chars, title search), tag?: string (1–32 chars, lowercased), cursor?: string, limit?: number (1–100, default 20) }`

**Response `200`**: `{ items: DocumentSummary[], nextCursor: string | null }`, cursor-paginated on `updated_at` descending.

`DocumentSummary` **deliberately excludes `content`** (use `GET
/documents/:id` for the body):

```ts
{
  id: string, title: string, tags: string[],
  sourceType: "manual" | "upload", sourceName: string | null,
  indexStatus: "pending" | "indexing" | "ready" | "failed",
  indexError: string | null, chunkCount: number,
  indexedAt: string | null, createdAt: string, updatedAt: string
}
```

**Errors**: `400` on an out-of-range query param. This call also lazily
re-enqueues any of the caller's own documents found stuck in
`pending`/`indexing` from a prior process restart — that sweep's own
failures are swallowed and never surface here.

### `GET /documents/:id`

**Response `200`**: `DocumentSummary & { content: string }`.

**Errors**: `400` invalid uuid; `404` not found or not visible under RLS.

### `POST /documents`

**Body**: `{ title: string (1–200 chars), content?: string (≤500,000 chars, default ""), tags?: string[] (each 1–32 chars, lowercased, ≤20 tags, deduped, default []) }`

**Response `201`**: the created `DocumentDetail`, with `indexStatus: "pending"` — indexing happens asynchronously after the response returns; poll `GET /documents/:id` to see it move to `ready`/`failed`.

**Errors**: `400` on any field out of bounds (empty title, oversized content, >20 tags).

### `PATCH /documents/:id`

**Body**: `{ title?: string, content?: string, tags?: string[] }` — same field constraints as create, but **at least one field is required** (an empty `{}` body is a `400`).

**Response `200`**: the updated `DocumentDetail`.

**Errors**: `400` empty/invalid body or invalid uuid; `404` not found. Re-indexing is only triggered if the recomputed `content_hash` actually changed — a tags-only edit updates the row but never re-queues indexing.

### `DELETE /documents/:id`

**Response `204`**, empty body.

**Errors**: `400` invalid uuid; `404` not found.

### `POST /documents/:id/reindex`

Re-queues indexing for a document currently stuck in a **failed** state — this is the only status it can be called from.

**Response `201`**: the updated `DocumentDetail` (`indexStatus` reset to `"pending"`, `indexError` cleared).

**Errors**: `400` invalid uuid; `404` not found; **`409`** if the document's current `indexStatus` isn't `"failed"` — calling this on a `pending`/`indexing`/`ready` document always conflicts.

---

## Chat & conversations

### `POST /chat/stream`

**Body** (`ChatRequestSchema`): `{ conversationId?: string, message: string (1–4000 chars), documentIds?: string[], tags?: string[] }`

**Response**: **not JSON** — `200`, `Content-Type: text/event-stream`. A body-validation failure still returns a normal `400` JSON error, since it's caught before any SSE header is written. Once the stream starts, every subsequent failure is delivered as an `error` event *inside* the 200 stream, not as an HTTP error status — the one exception is an unknown/inaccessible `conversationId`, which fails before the `start` event and is still surfaced as an `error` event (not a 404), since by the time it's caught the response has already committed to SSE.

Event sequence: `start` → `sources` → (`delta` | `citation`)\* → `done` **or** `error`.

```ts
{ type: "start", conversationId: string, userMessageId: string, assistantMessageId: string }
{ type: "sources", sources: { sourceId: string, documentId: string, documentTitle: string, headingPath: string | null, similarity: number, score: number }[] }
{ type: "delta", text: string }
{ type: "citation", sourceId: string }
{ type: "done", finishReason: "stop" | "length" | "aborted", usage: { promptTokens: number, completionTokens: number, totalTokens: number, estimated: boolean } }
{ type: "error", code: string, message: string }
```

A client disconnect aborts the underlying LLM call; a client-initiated stop is **not** an error — it ends as a normal `done` event with `finishReason: "aborted"`. A 15-second `: heartbeat` comment line keeps idle proxies from timing the connection out; SSE comment lines are not events and should be ignored by any client.

**Errors**: `400` body validation (before streaming starts); `429` rate limit (before streaming starts); everything else is an in-stream `error` event as described above, always inside an HTTP `200`.

### `POST /chat`

The non-streaming equivalent — same `ChatService` orchestration, collected into one JSON response instead of SSE. Same body shape and rate-limit bucket as `/chat/stream` (they share one counter).

**Response `201`** (no explicit status code is set, so this is Nest's default for `POST`):

```ts
{
  conversationId: string,
  userMessage: Message,
  assistantMessage: Message,
  sources: SourceSummary[]
}
```

`Message`: `{ id: string, role: "user" | "assistant", content: string, status: "streaming" | "complete" | "aborted" | "error", citations: CitationSnapshot[], retrieval: RetrievalDebug | null, model: string | null, createdAt: string }`

`CitationSnapshot`: `{ sourceId, documentId, documentTitle, headingPath, snippet (≤300 chars), charStart, charEnd, similarity, score }`

`RetrievalDebug`: `{ rewrittenQuery: string, usedRewrite: boolean, sourceCount: number }`

**Errors**: `400` body validation; `404` unknown/inaccessible `conversationId` — this **does** surface as a real HTTP 404 here, unlike the streaming route, because nothing has been written to the response yet when it's thrown. A retrieval or LLM failure *after* the conversation resolves does **not** throw — it comes back as a normal `200`-shaped response with `assistantMessage.status: "error"` (or `"aborted"`).

### `GET /conversations`

**Query**: `{ cursor?: string, limit?: number (1–100, default 20) }`

**Response `200`**: `{ items: { id, title, createdAt, updatedAt }[], nextCursor: string | null }`, cursor-paginated on `updated_at` descending.

### `GET /conversations/:id`

**Response `200`**: the conversation summary plus `messages: Message[]` (oldest first).

**Errors**: `400` invalid uuid; `404` not found or not visible under RLS.

### `PATCH /conversations/:id`

**Body**: `{ title: string (1–200 chars) }`

**Response `200`**: the updated conversation summary.

**Errors**: `400` invalid body/uuid; `404` not found.

### `DELETE /conversations/:id`

**Response `204`**, empty body.

**Errors**: `400` invalid uuid; `404` not found.

---

## Usage

### `GET /usage`

**Query**: `{ days?: number (1–365, default 30) }`

**Response `200`**:

```ts
{
  from: string,       // ISO date, today - days
  days: number,
  totals: { promptTokens: number, completionTokens: number, totalTokens: number, eventCount: number },
  rows: { day: string, operation: "chat" | "embedding" | "query_rewrite", model: string, promptTokens: number, completionTokens: number, totalTokens: number, eventCount: number }[]
}
```

One row per (day, operation, model). Backed entirely by reads — every
number here reflects `ai_usage_events` rows written elsewhere (chat turns
record `"chat"`, indexing records `"embedding"`, query rewriting records
`"query_rewrite"`), each written best-effort so a usage-logging failure
never fails the operation it's describing.

**Errors**: `400` if `days` is out of the 1–365 range.
