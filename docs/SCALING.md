# Scaling Notes

An honest bottleneck analysis of the app as it's actually built today, not
a generic "how to scale a RAG app" essay. Every item below is grounded in a
specific implementation choice documented in `docs/ARCHITECTURE.md` or
`docs/DECISIONS.md`. Ranked roughly by which limit you'd hit first.

## 1. The indexing queue is now durable and multi-replica-safe — but still only ever runs request-adjacent

Updated (D9.14, Phase 9): `IndexingQueue` used to be a purely in-memory
`p-queue` living inside the request-serving process — a restart silently
dropped every queued job, and two `apps/api` replicas would each believe
they alone owned the world. That's fixed: `document_indexing_jobs` (see
`supabase/migrations/*_document_indexing_jobs.sql`) is a durable,
RLS-scoped Postgres table, and a new `claim_indexing_jobs` RPC
(`security invoker`, `for update skip locked`) claims jobs atomically —
verified under real concurrent transactions, not just reasoned about, see
`docs/DECISIONS.md` D9.14.

**What's actually fixed now:**

- **Two `apps/api` replicas no longer duplicate embedding work.** Whichever
  replica's `claim_indexing_jobs` call commits first gets the job; every
  other concurrent claim — same replica or a different one — atomically
  skips it (`for update skip locked`) and returns nothing. The "you'd be
  doing the embedding work twice for no benefit" scenario this item used to
  describe is closed.
- **A process restart no longer drops queued work.** The job is a Postgres
  row, not a Node `Map` entry — it survives the crash that would have taken
  the old in-memory queue's state with it.

**What's still true, and structurally has to stay true:** there is still
no boot-time or timer-driven background worker, and there structurally
can't be one without reopening a risk this app has avoided since Phase 1.
Every Postgres access here runs as some real user's own, already-verified
JWT — RLS is the *only* authorization boundary anywhere in `apps/api`
(D3.6) — and a generic poller with no request behind it has no such JWT to
run as. So claiming a job only ever happens two ways: immediately after
`enqueue()`, using the JWT that request just authenticated with; or via
`documents.service.ts`'s lazy `resumeStuckIndexing` sweep on the next
`list()`/`getById()` call from *any* request for that same user (now
claiming from the durable table, not re-deriving stuck-ness from
`documents.index_status`). **A document whose owner never makes another
request after a crash still stays stuck until they do** — this was true
before D9.14 and remains true after it; what changed is that the job is
now guaranteed to still be there, correctly claimable, whenever that next
request finally arrives, and that two replicas racing to pick it up can no
longer both succeed.

**What this means in practice**: one `apps/api` instance still indexes at
most 2 documents at once, system-wide (the local `p-queue` concurrency
limit is unchanged) — but now that limit is genuinely a per-replica local
concurrency cap, not a correctness assumption. Running `apps/api` at
`replicas: 2+` is safe from a duplicate-work/corruption standpoint in a way
it wasn't before this entry; there is still no deploy target that actually
runs more than one replica (see `docs/DEPLOYMENT.md`), so this is a closed
correctness question, not yet an exercised one.

**The one thing that would still need building, if "no worker until the
next request" ever becomes the real constraint**: not a generic background
poller (that's the option D3.6 already ruled out for this app), but a
scheduled trigger that authenticates as a specific user on a timer — a
narrower, differently-scoped feature than "a background worker," and one
this project hasn't needed yet.

## 2. Rate limiting is per-process, not global — fixed (D9.15), opt-in

Updated (D9.15, Phase 9): `@nestjs/throttler` used to be configured with no
custom storage provider, defaulting to in-memory counters — with a single
`apps/api` process this behaved exactly as documented (120 req/min default,
20 req/min for chat, per user), but the moment you ran more than one
instance behind a load balancer, each instance kept its own counter — a
user's effective limit became (configured limit) × (instance count), not
the configured limit. Silent: nothing broke, the limits just stopped
meaning what the config said they meant.

**The fix**: set `REDIS_URL` and every `apps/api` replica shares one set of
counters instead. `RedisThrottlerStorage`
(`apps/api/src/common/redis-throttler-storage.ts`) implements
`@nestjs/throttler`'s own `ThrottlerStorage` interface with a single atomic
Redis `EVAL` (a fixed-window counter plus a separate block-flag key) —
hand-rolled against `ioredis` rather than a dependency on
`@nest-lab/throttler-storage-redis`, whose declared peer range
(`@nestjs/common`/`@nestjs/core` up to `^11`) doesn't cover this app's
installed `12.0.3`. See `docs/DECISIONS.md` D9.15 for the full design,
including why it's a standard fixed-window counter rather than a
byte-for-byte port of the in-memory implementation's per-hit-decrement
quirk, and how "two replicas share one limit" was verified against a real
Redis (not mocked) — two independent `RedisThrottlerStorage` instances
pointed at the same Redis, proven to enforce one combined limit where two
independent in-memory `ThrottlerStorageService` instances (the literal
pre-fix bug) don't.

**Left unset (still the default)**: exactly the old behavior —
`ThrottlerModule`'s own fallback constructs the built-in in-memory storage,
same as before D9.15 existed. This is opt-in, not a forced migration,
because nothing in this repo actually runs more than one `apps/api`
replica yet (see item 7) — there's no reason to require Redis as a
prerequisite for local dev or a single-instance deployment. Fails **open**,
not closed: if Redis is unreachable when `REDIS_URL` is set, a request is
allowed through and the error is logged, rather than every request being
rejected or hanging — a rate limiter that's temporarily down is a smaller
problem than an API that is.

## 3. Chat streaming holds a long-lived connection on one instance

`POST /chat/stream` is a plain HTTP response held open for the duration of
generation (SSE, not WebSockets, but the same constraint applies): whichever
`apps/api` instance accepted the request owns that connection until it
ends. Horizontally scaling `apps/api` is fine for short requests (any
instance can serve any request, statelessly) but a load balancer that
doesn't support long-lived connections well, or that reroutes mid-stream,
will kill an in-progress chat answer. The 15-second heartbeat already in
place helps with idle-timeout proxies specifically, but doesn't help with
a hard reroute.

**The fix**: make sure whatever sits in front of `apps/api` (load balancer,
reverse proxy) is configured for long-lived HTTP connections and doesn't
buffer the response — `X-Accel-Buffering: no` is already sent for nginx's
benefit, but an equivalent setting may be needed for other proxies/CDNs.

## 4. `document_chunks`'s HNSW index costs more to write as the corpus grows

The `vector(1536)` column has an HNSW index (`m=16, ef_construction=64`).
HNSW gives fast approximate search, but every chunk write pays an
increasing insertion cost as the index grows, and `replace_document_chunks`
deletes and re-inserts *every* chunk for a document on each edit — a small
doc re-indexes cheaply, but a very large, frequently-edited document
re-pays that insertion cost on every save. This is a real but gradual
cost, not an immediate ceiling — worth watching via query/write latency as
total chunk count grows, not something to pre-optimize.

**Levers available without a schema change**: tune `ef_search` at query
time (a runtime GUC, not a migration) to trade recall for speed as the
corpus grows; `RAG_CHUNK_TOKENS`/`RAG_CHUNK_MAX_TOKENS` directly control
how many chunks (and thus how many vector rows) each document produces —
Phase 8's eval harness (`pnpm eval`) exists specifically to measure the
retrieval-quality effect of changing them, so this isn't a blind trade-off.
The `match_document_chunks` migration also already has a targeted,
deliberately-deferred optimization noted in a code comment: pgvector ≥0.8's
HNSW iterative scan (`hnsw.iterative_scan`) avoids under-returning results
when `filter_document_ids`/`filter_tags` narrow the ANN candidate set
heavily — left disabled for now specifically because the installed
pgvector version wasn't confirmed to support it, not because it isn't
worth doing. Confirming the version and enabling it is a one-line change
when tag/document-scoped chat questions on a large corpus start showing
this effect.

## 5. Every request opens a fresh, independently-scoped Postgres client

Because RLS enforcement depends on every query running as the calling
user's own JWT, there is no shared connection pool an admin client could
hide behind — each request builds its own request-scoped Supabase client.
At the scale this app is built for (a single Postgres instance, RLS doing
the isolation work), this is the right tradeoff and not a bottleneck yet.
It becomes one at high request volume, where Postgres's own connection
limit is the real ceiling — standard PgBouncer-style pooling in front of
Postgres (which a hosted Supabase project already provides) is the
mitigation, not an application-level change.

## 6. External AI provider calls are the real latency and cost driver

Every chat turn makes at least one embedding call and one chat-completion
call (more, if query rewriting is enabled and history exists); every
document save makes one embedding call per chunk batch. `AI_REQUEST_TIMEOUT_MS`
(default 60s) and `AI_MAX_RETRIES` (default 2) already bound how long a
single call can block a request, but neither retries nor timeouts change
the fact that the app's real-world latency floor is whatever the
configured provider takes to respond. This scales with usage roughly
linearly and isn't something the app's own architecture can improve —
provider choice (`docs/PROVIDERS.md`), not code, is the lever here.

## 7. Packaging exists (D9.13); the indexing-queue correctness blocker is now fixed too (D9.14) — only a deploy target is still missing

Updated (D9.13, then D9.14, Phase 9): `apps/api/Dockerfile` and
`apps/web/Dockerfile` exist, and `.github/workflows/ci.yml` builds both on
every push — see `docs/ARCHITECTURE.md`'s "Deployment shape as it exists
today" and `docs/DEPLOYMENT.md`. That closed "there's no way to even
package this," which used to be the literal first blocker here.

D9.14 then closed what this item used to describe as the remaining
correctness blocker: `apps/api`'s indexing queue is no longer in-memory
(see item 1, above, for the full writeup) — a second replica claiming
document-save indexing work via `claim_indexing_jobs` can no longer
silently duplicate another replica's work or lose it on restart. Two
`apps/api` replicas behind a load balancer would no longer corrupt or
duplicate indexing work purely by both existing.

What's still genuinely missing is everything item 1 already says isn't
fixed and can't be by this app's own design: there's still no background
worker independent of a live request (only request-adjacent claiming —
see item 1), and, separately and more simply, **no deploy target exists at
all** — no host, no Kubernetes cluster, no autoscaling group configured to
actually run more than one `apps/api` replica. Item 2 (shared rate-limit
store) is now actually built, not just theoretically safe — set
`REDIS_URL` and it's in effect. Item 3 (long-lived-connection-aware load
balancing) is still a configuration concern for whatever eventually sits in
front of this app, not something this repo's own code can close. Both are
ready from a correctness standpoint; there's still nothing to run them
against.

## What's already handled well, and doesn't need revisiting for scale

Worth stating so this document doesn't read as "nothing works" — several
things here are already built the way you'd want them at scale, not just
at demo size: RLS-based isolation means adding read replicas or connection
pooling never risks a cross-user data leak, since the database enforces it
regardless of application code; the hybrid retrieval RPC is a single SQL
round-trip (no N+1 pattern); the citation-stream parser and SSE plumbing
add no buffering beyond what the heartbeat needs; and the AI provider layer
is already fully swappable via env vars, so moving to a higher-throughput
or lower-latency provider under load needs zero code changes.
