# Scaling Notes

An honest bottleneck analysis of the app as it's actually built today, not
a generic "how to scale a RAG app" essay. Every item below is grounded in a
specific implementation choice documented in `docs/ARCHITECTURE.md` or
`docs/DECISIONS.md`. Ranked roughly by which limit you'd hit first.

## 1. The indexing queue can't survive more than one `apps/api` process

`IndexingQueue` is an in-memory `p-queue`, concurrency 2, living inside the
same process that serves HTTP requests. This is the single biggest
structural limit on this app's scale, for two separate reasons:

- **You can't run `apps/api` as more than one replica without breaking its
  own guarantees.** The "latest job wins, one job per document at a time"
  logic and the stuck-job tracking both assume there is exactly one queue.
  Two replicas would each have their own independent queue and could
  process the same document concurrently — `replace_document_chunks`'s
  `content_hash` guard would stop them from corrupting each other's writes,
  but you'd be doing the embedding work (real API calls, real cost) twice
  for no benefit.
- **A process restart silently drops every queued job.** Nothing is
  persisted. The lazy `resumeStuckIndexing` sweep (see Architecture)
  recovers from this, but only when the affected user happens to load their
  documents list again — there's no guarantee that happens promptly, or at
  all for an abandoned account.

**What this means in practice**: today, one `apps/api` instance can index
at most 2 documents at once, system-wide, across every user — not per user.
A burst of uploads from multiple users queues up behind that limit.

**The fix, if this becomes a real constraint**: move indexing off the
request-serving process entirely, onto a real job system with persistence
— either `pg-boss` (runs on the same Postgres already in use, no new
infra) or a dedicated broker (Redis + BullMQ) with its own worker
process(es). That also removes the "must be the same process" constraint
on `apps/api` itself, letting it scale horizontally.

## 2. Rate limiting is per-process, not global

`@nestjs/throttler` is configured with no custom storage provider, which
means it defaults to in-memory counters. With a single `apps/api` process
this behaves exactly as documented (120 req/min default, 20 req/min for
chat, per user). The moment you run more than one instance behind a load
balancer, each instance keeps its own counter — a user's effective limit
becomes (configured limit) × (instance count), not the configured limit.
This is silent: nothing would break, the limits would simply stop meaning
what the config says they mean.

**The fix**: a shared storage backend for the throttler (Redis is the
standard choice — `@nest-lab/throttler-storage-redis` or similar) before
running more than one `apps/api` instance.

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

## 7. There's now a way to run one instance of each app — multi-replica scaling still has nothing to exercise it

Updated (D9.13, Phase 9): `apps/api/Dockerfile` and `apps/web/Dockerfile`
now exist, and `.github/workflows/ci.yml` builds both on every push — see
`docs/ARCHITECTURE.md`'s "Deployment shape as it exists today" and
`docs/DEPLOYMENT.md`. That closes "there's no way to even package this,"
which used to be the literal first blocker here. It does NOT close this
item's actual scaling concern: `apps/api`'s in-memory `IndexingQueue`
still means exactly one instance, no more, can safely run at a time (a
second replica would silently split document-save requests and
`resumeStuckIndexing` sweeps across two independent, unaware-of-each-other
queues — see `docs/ARCHITECTURE.md`). None of the scaling levers above
(multiple `apps/api` replicas, a shared rate-limit store, a real job
queue) can be exercised until that gets a real fix — a persisted job queue
(the obvious candidate: a `document_indexing_jobs` table plus a poll loop,
so any instance can pick up a stuck job, not just the one that enqueued
it) is still deliberately unbuilt, not merely unautomated. No deploy
target (a host, a Kubernetes cluster, an autoscaling group) exists to run
more than one instance on yet either, even if the queue were fixed first.

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
