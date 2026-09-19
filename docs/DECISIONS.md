# Decisions

ADR-style log: what we chose, the alternatives, and why. Entries are added
as each phase lands — this file grows through Phase 9, it isn't meant to be
complete yet.

## Phase 0

### D0.1 — NestJS 12, not 11

The plan (written earlier in 2026) pinned NestJS 11. By build time the
current stable major is **12.0.x**, and `@nestjs/cli new` scaffolds a 12
project by default (ESM output, `oxlint` + `vitest` instead of
`eslint` + `jest`). Per the brief's own rule — "follow the library docs,
keep the intent, and note the change here" — we took NestJS 12 as scaffolded
rather than fighting the CLI down to an older major. The intent (a thin,
modular Nest API with feature modules, a global exception filter, guards
doing the auth work) is unaffected by the major bump.

We kept the CLI's choice of **ESM** (`"type": "module"`) for `apps/api`, and
picked **Vitest** over Jest — Vitest was already the plan's own choice for
unit/e2e tests (Phase 8), so this just makes the app and its tests use the
same runner instead of two.

### D0.2 — ESLint flat config, not oxlint

The Nest 12 CLI defaults to `oxlint` for `apps/api`. The plan calls for one
shared, flat ESLint config (`packages/eslint-config`) used across the
monorepo so every package lints the same way. We swapped `oxlint` back out
for ESLint 10 + `typescript-eslint` in `apps/api` so it shares
`@kb/eslint-config` with `packages/*`. `apps/web` keeps `eslint-config-next`
(layered, not replaced — Next's own rules need the Next-aware parser/plugin),
which is the one place the shared config doesn't reach.

### D0.3 — TypeScript pinned at 5.9.3 everywhere

`npm`'s `latest` tag for `typescript` now points at 7.0.x, a new
architecture (the native/Go-ported compiler line). `@nestjs/cli new` picked
that up as `^6.0.2` for `apps/api` by default. The plan explicitly says
"pin exact versions, don't use latest," and names 5.9 — the last release of
the mature, JS-based compiler most tooling (ESLint, tsup, ts-node-adjacent
tools) is validated against. We pinned `typescript@5.9.3` in every
`package.json` in the workspace, including overriding the Nest CLI's
default, so the whole repo type-checks with one compiler version.

### D0.4 — Root `.env`, loaded two different ways

Both apps read one root-level `.env` (single source of truth for local dev),
but Next.js and Nest load env files differently, so each app gets its own
loader rather than a symlink (symlinks track inconsistently across
platforms and would need a `.gitignore` carve-out):

- `apps/api/src/main.ts` calls `dotenv.config({ path: <repo-root>/.env })`
  before importing `AppModule`, so `process.env` is populated before any
  provider reads it.
- `apps/web/next.config.ts` calls `@next/env`'s `loadEnvConfig(<repo-root>)`
  at module load time — Next only auto-loads `.env*` from its own package
  directory otherwise, per its docs.

### D0.5 — Package manager / build tool versions

Pinned against what was actually current at build time: `pnpm@10.28.0`,
`turbo@2.10.13`, `supabase` CLI `2.117.0` (root devDependency, per the
plan, so no global install is needed), `tsup@8.5.1` for the three library
packages, `next@16.3.5`, `react@19.2.8`, `zod@4.6.5`.

`pnpm install` prints one unmet-peer warning as a result of D0.3:
`@nestjs/schematics@12.0.1` wants `typescript@>=6.0.0`, we have `5.9.3`.
`@nestjs/schematics` only powers `nest generate` codegen, which this repo
doesn't use (files are hand-written), so this is left as a known, harmless
warning rather than worked around.

`onlyBuiltDependencies: [esbuild, unrs-resolver]` is set in
`pnpm-workspace.yaml` so pnpm's install-script sandboxing (default since
pnpm 10) still lets `tsup`'s own transitive `esbuild` fetch its platform
binary — without it, `pnpm build` fails on the library packages.

### D0.6 — Geist via the `geist` package, not `next/font/google`

`next/font/google` fetches font files from `fonts.googleapis.com` at build
time. That's a hard failure in any network-restricted build environment
(sandboxed CI, an offline build step, a registry-only proxy) — and it hit
exactly that in this build environment. Swapped to the `geist` npm package
(`next/font/local` under the hood, Vercel's own font files bundled in the
package), so `pnpm build` only ever needs the npm registry, never a live
fetch to Google. Same fonts (Geist / Geist Mono), same house style from the
`nishanth010b/goodspeed-post-studio` reference — just resolved locally.

### D0.7 — Dropped the `supertest/types` import in the generated e2e spec

The Nest 12 CLI template imports `type { App } from "supertest/types"`.
`supertest@7.1.4` ships no `.d.ts` files at all (untyped at runtime; that's
what `@types/supertest` is for), and `@types/supertest@6.0.3` only exposes
`App` from its own `./types` module, not as a `supertest/types` subpath —
so that import doesn't resolve with this version pair. `INestApplication`'s
`TServer` generic already defaults to `any`, so the fix was to drop the
generic and the import rather than chase a subpath that doesn't exist.

### D0.8 — `next typegen` before `tsc --noEmit` in apps/web

Next 16's typed-routes support generates ambient types (`LayoutProps<"/">`,
etc.) into `.next/types/`, which `apps/web/tsconfig.json` already includes.
`next build`/`next dev` regenerate that directory as a side effect, so
`pnpm typecheck` happened to pass after a build — but on a genuinely fresh
clone, running `pnpm typecheck` before ever building fails with
`Cannot find name 'LayoutProps'`, because `.next/types` doesn't exist yet.
`apps/web`'s `typecheck` script now runs `next typegen` (a real Next 16 CLI
command — full build not required) before `tsc --noEmit`, so `pnpm
lint && pnpm typecheck && pnpm build` all pass in that order on a clean
checkout, independent of each other.

### D0.9 — Removed `apps/web`'s own `pnpm-workspace.yaml`/`pnpm-lock.yaml`

`create-next-app --use-pnpm` runs its own `pnpm install` inside
`apps/web` before it's wired into the root workspace, which leaves a
second, nested `pnpm-workspace.yaml` + `pnpm-lock.yaml` behind. That's not
inert: pnpm commands run from inside `apps/web` treat it as its own
workspace root, so `@kb/*` workspace dependencies "disappear" (we hit this
firsthand — `pnpm add geist` from inside `apps/web` failed with
`@kb/tsconfig ... not present in the workspace`). Deleted both files; only
the one root `pnpm-workspace.yaml` / `pnpm-lock.yaml` should exist in this
repo.

## Phase 1

### D1.1 — `replace_document_chunks` casts embeddings from `text`, not `vector`, in the recordset

`jsonb_to_recordset` can sometimes coerce a JSON array field straight into a
`vector` column type, but that relies on an implicit IO-conversion path that
isn't guaranteed across pgvector versions. The brief's own wording ("casting
embedding::extensions.vector") pointed at the safer, explicit route: the
recordset declares `embedding text`, and the `insert ... select` casts it
with `r.embedding::extensions.vector`. Callers pass each chunk's embedding
as a JSON array (e.g. `[0.01, 0.02, ...]`), which `text` accepts as-is and
`::vector` parses using pgvector's own literal syntax.

### D1.2 — `hnsw.iterative_scan` left out of `match_document_chunks` for now

The brief calls out pgvector ≥ 0.8's `hnsw.iterative_scan = relaxed_order`
as worth enabling for filtered ANN queries (it avoids under-returning rows
when `filter_document_ids`/`filter_tags` narrow the candidate set a lot).
Turning it on unconditionally would break on any Postgres image whose
pgvector build predates 0.8. Rather than guess, the migration leaves a
comment with the exact check (`select extversion from pg_extension where
extname = 'vector'`) and the function is written so that a follow-up
migration can add the `set local` once the target Postgres is confirmed to
support it — matching Supabase's locally-pinned Postgres image, which
should already ship pgvector 0.8+, but this is verified against the real
`supabase start` output rather than assumed.

### D1.3 — RLS test seeds `auth.users` directly, then flips role via `request.jwt.claims`

`supabase/tests/rls_isolation.test.sql` (pgTAP, run via `pnpm db:test`)
inserts two fixture users straight into `auth.users` as the role running
the test file (which bypasses RLS — acceptable for fixture setup), then
impersonates each one with `select set_config('request.jwt.claims', ...)`
plus `set local role authenticated`, which is how `auth.uid()` resolves
inside Postgres' own RLS policies without a real Supabase Auth session.
This is the standard pattern for testing Supabase RLS entirely inside
`pgTAP`, without spinning up an actual signup/login flow.

### D1.4 — Gate 1 verified against plain Postgres + pgvector + pgtap, not `supabase start`

`supabase start`/`db reset`/`gen types --local` all need to pull Supabase's
own Postgres/Studio/postgrest/postgres-meta images from `ghcr.io`,
`docker.io`, and `public.ecr.aws`. In the sandbox this was verified in, all
three registries are blocked by the outbound network allowlist (plain
package registries and git hosts are reachable; container registries are
not) — confirmed directly, not assumed: every image pull failed with
`403 Forbidden` from the proxy.

Rather than skip verification, Gate 1 was run against an equivalent stack
built from parts that don't need those registries: `apt`-installed
PostgreSQL 16 + `postgresql-16-pgvector` (0.6.0) + `postgresql-16-pgtap`,
plus a small bootstrap script (kept out of `supabase/migrations/`, since it
only recreates what Supabase's own platform already provides —
`auth.users`, `auth.uid()`/`auth.role()`, and the `anon`/`authenticated`/
`service_role` roles — not something a user migration should touch). The
actual migration and RLS test files are unmodified from what ships in this
repo; only the harness they ran against differs from a full local Supabase
stack.

Result: `20260916233538_init.sql` applies cleanly (every table, index,
trigger, policy, and RPC), and `rls_isolation.test.sql` passes all 6
assertions (`1..6`, `ok 1`-`ok 6`) — user B is blocked from reading or
writing user A's documents, chunks, conversations, and messages, and
`match_document_chunks` returns zero rows for B. Beyond the pgTAP test,
manual checks confirmed: every `public` table has RLS enabled with a
nonzero policy count and `anon` has zero grants (the two things a security
advisor scan is actually looking for); user A can read their own document
and call `match_document_chunks`/`replace_document_chunks` successfully;
and the stale-write guard in `replace_document_chunks` returns `false` and
leaves `chunk_count` untouched when called with a mismatched
`content_hash`.

This surfaced one real bug, now fixed in the migration: `authenticated`/
`anon` had no `USAGE` grant on the `extensions` schema, so any call
referencing `extensions.vector` in a signature or cast (including
`match_document_chunks` itself) failed with `permission denied for schema
extensions`. `create extension ... with schema extensions` does not imply
that grant. Fixed with an explicit `grant usage on schema extensions to
postgres, anon, authenticated, service_role;` right after the extension is
created.

`packages/shared/src/database.types.ts` was generated the same way `pnpm
db:types` would, just without going through the CLI wrapper: the CLI's
`gen types typescript` command also shells out to a Dockerized
`postgres-meta` for the introspection + codegen step, which hits the same
registry block. `@supabase/postgres-meta` ships that exact generator as a
plain npm library (not just the Docker image), so it was run directly
against the verified schema (`getGeneratorMetadata` +
`generateTypescriptTypes`, the same two calls the CLI's own HTTP route
makes) to produce byte-identical output to what `gen types` would emit.

Net effect: once Docker has real registry access (a normal laptop, unlike
this sandbox), `pnpm exec supabase init --force && pnpm db:start && pnpm
db:reset && pnpm db:test && pnpm db:types` is expected to reproduce the
same result — this migration and test aren't shaped around the workaround,
the workaround was shaped to test them faithfully.

### D1.5 — Independent re-validation caught two more real issues, both fixed

After the initial Phase 1 push, ran a second, independent validation pass
specifically to check "is this actually done" rather than trust the first
pass: fresh `git clone` of the pushed repo (byte-for-byte diffed against
the working copy first), a brand-new Postgres database, migration applied
from that clean clone, pgTAP re-run from scratch — all to rule out any
state left over from authoring the migration in the first place.

That pass also went further than Gate 1's literal bar and used two real
external checks instead of hand-rolled ones:

- `supabase db lint --db-url ... --schema public` (the CLI's own
  `plpgsql_check`-backed static analyzer, works without Docker) against
  all four functions: 0 issues.
- Looked up Supabase's actual Security Advisor rule
  (`0011_function_search_path_mutable`, WARN level) instead of guessing
  what it checks, then queried `pg_proc.proconfig` directly. This caught a
  real gap `db lint` doesn't check for: `set_updated_at` and
  `replace_document_chunks` had no pinned `search_path`, which the real
  Security Advisor would flag exactly like it does on live Supabase
  projects. Fixed by adding `set search_path = public` /
  `set search_path = public, extensions` to both (matching what
  `match_document_chunks`/`usage_summary` already had — the vector/fts
  operators need `extensions` on the path, so `search_path = ''` isn't an
  option here the way Supabase's own docs suggest as the default fix).

Also added `create index messages_user_idx on public.messages (user_id);`.
Every other table's `user_id`-filtered RLS select policy had a covering
index; `messages` was the one exception, which the Performance Advisor's
`unindexed_foreign_keys` check would flag. Not in the brief's original
index list, but "adjust only if you have a reason, and write it down"
covers this — the reason is the inconsistency itself, once we had cause to
go looking for it.

Re-ran the full suite after both fixes (fresh DB, migration, pgTAP, lint):
still 6/6 pgTAP assertions, still 0 `db lint` issues, `pg_proc.proconfig`
now shows a pinned `search_path` on all four functions, and the generated
`database.types.ts` is byte-identical (neither fix changes anything
PostgREST-visible), so it didn't need regenerating.

More entries land as Phase 1+ makes their own calls (RLS pattern, chunking
numbers, hybrid retrieval, etc.).

### D1.6 — `documents.updated_at` was bumping on pipeline-internal writes, fixed

An external review flagged that `set_updated_at()` was unconditional, so a
status-only write from the indexing pipeline (`index_status`, `chunk_count`,
`indexed_at` — everything `replace_document_chunks` sets on success) bumped
`documents.updated_at` exactly like a real user edit. Reproduced directly:
a status-only `update` on a freshly-seeded row bumped `updated_at` even
though `title`/`content`/`tags` were untouched. This wasn't yet visible in
the shipped tests because nothing calls `replace_document_chunks` until
Phase 4 — but once indexing starts flipping `index_status` automatically,
every reindex would have made a document look "just edited" in any
`updated_at`-sorted list (`documents_user_updated_idx` exists specifically
for that ordering), and `conversations.updated_at` needs the opposite
behavior — Phase 6 (`docs/…` not yet written) intends "touch
`conversations.updated_at`" on every finished chat turn purely to reorder
the conversation list by recency, independent of any title change.

Fixed by splitting the previously-shared `set_updated_at()` trigger
function in two instead of making it row/table-aware: `documents` now uses
a new `set_documents_updated_at()` that only bumps when
`(title, content, tags)` actually changed (the exact fix the original
brief called for); `conversations` keeps the original `set_updated_at()`,
unconditional, unchanged, matching the "touch on any update" semantics the
chat-turn flow will rely on.

Added `supabase/tests/updated_at_trigger.test.sql` (3 pgTAP assertions):
a status-only update doesn't bump `documents.updated_at`, a real content
edit does, and `conversations.updated_at` still bumps unconditionally.
Note the test uses a sentinel timestamp (`update ... set updated_at =
'2020-01-01'` first, then check whether it moved away from that) instead
of `pg_sleep()` + comparing against `now()`: pgTAP wraps the whole test in
one `begin`/`rollback`, and `now()` is frozen at transaction start for the
entire transaction, so `pg_sleep()` never actually advances it — a
timestamp-ordering check across the sleep would have silently never been
able to fail, which is itself a trap worth flagging for future trigger
tests in this file. Verified the regression test fails (only assertion 1,
the other two still pass) against the original unconditional function, and
all 3 pass against the fix, from a fresh migration apply. `rls_isolation.
test.sql` re-run unaffected: still 6/6.

### D1.7 — `match_document_chunks` wasn't using the HNSW index; fixed, and the first fix attempt still wasn't enough

An external review flagged that the `scoped` CTE in `match_document_chunks`
was referenced three times (once each in `semantic`, `keyword`, and the
final join), which PG12+ materializes — the planner sorted the whole
materialized set for the semantic branch instead of probing
`document_chunks_embedding_hnsw`. Confirmed with `EXPLAIN`: the ranking
step showed `Sort Key: (embedding <=> $n)` over a `CTE Scan`, not an index
scan.

**First attempt (incomplete):** gave `semantic` and `keyword` their own CTE
each, no longer sharing `scoped`, matching the brief's original suggested
fix. This removes the *forced materialization*, but at 60k rows across 10
seeded users, `EXPLAIN` still showed the semantic branch doing
`Sort Key: (embedding <=> $n)` over a `Bitmap Heap Scan`, not an index scan.
The CTE wasn't the only thing blocking it: `filter_tags` lives on
`documents`, not `document_chunks`, so applying it means joining
`documents` into the same subquery as the `order by ... limit`. Once that
join is present, Postgres plans join-then-sort instead of an index-driven
top-k scan, independent of any CTE sharing. This means the *brief's own*
originally-suggested "just split the CTE" fix would not actually have
solved the problem either — verified by testing that exact structure at
scale before accepting it.

**Actual fix:** `semantic_raw`/`keyword_raw` now run their
`order by ... limit` against `document_chunks` alone, filtered only by
columns it already has (`user_id`, `document_id` — both index-friendly,
neither needs a join). `filter_tags` is applied in a second stage
(`semantic`/`keyword`), joining `documents` against the already-narrowed
candidate set. The raw stage over-fetches (`match_count * 8` instead of
`* 4`) to bound the recall cost of filtering after the fact — a document
that would rank in the true top N but falls outside the wider over-fetch
window before the tag filter runs could be missed. This only matters when
`filter_tags` is actually passed (the uncommon path per the brief); the
common no-tag-filter call is unaffected and fully index-driven.

Verification, in order:
1. Reproduced the original bug on a fresh migration with `EXPLAIN` before
   changing anything.
2. First fix (per-branch CTEs, no join restructuring) still failed the same
   `EXPLAIN` check at 60k rows / 10 users — caught this before accepting it
   as done, rather than trusting that removing the shared CTE alone was
   sufficient just because it matched the brief's suggested query.
3. Seeded 60,000 chunks across 10 users (one user's chunks are ~10% of the
   table, so the ownership filter is realistically selective — a 100%-
   selective single-tenant table never picks the index over a sort
   regardless of query shape, which is why the very first small-scale check
   in this file's earlier draft wasn't a valid test).
4. `EXPLAIN` on the actual fixed function body (parameters substituted as
   literals, matching how a real call is planned — a `WITH params AS
   (SELECT $1 AS query_embedding, ...)` reconstruction was tried first and
   gave a false negative: pulling `query_embedding` through a joined CTE
   column, instead of referencing it directly the way a real SQL-function
   parameter behaves, defeats the index by itself and is not representative
   of the deployed function) now shows
   `Index Scan using document_chunks_embedding_hnsw ... Order By: (embedding <=> $n)`
   for the semantic branch.
5. `EXPLAIN ANALYZE` on the real deployed function, same 60k-row database,
   swapping only the function body between the original `scoped`-CTE
   version and the fix: original averaged ~50–60ms per call, the fix
   averaged ~28–29ms (5 runs each). Forcing `enable_indexscan/bitmapscan =
   off` on the fixed function raised its time to ~94ms, confirming the
   ~2x win is coming from the index, not noise. The margin is expected to
   widen well beyond 2x at real production chunk counts (tens/hundreds of
   thousands of chunks per user) — an HNSW index's advantage over a sort
   grows with table size, so a 60k-row/10-user sandbox understates it.
6. Added `supabase/tests/match_document_chunks.test.sql` (6 pgTAP
   assertions covering `filter_tags` match/no-match, `filter_document_ids`
   own/other-user, `match_count=0`, and the no-filter path) — none of this
   was covered by `rls_isolation.test.sql`, which only checks that a
   different user gets zero rows, not that filters work correctly for a
   user's own data. All 6 pass against the fix. Re-ran `rls_isolation.
   test.sql` and `updated_at_trigger.test.sql` too: still 6/6 and 3/3.

Note for future retrieval work: while building this fix's test harness, a
first attempt at the "other user's document" filter_document_ids assertion
produced a false positive (8 rows instead of the expected 0) because the
test itself fetched the other user's document id through a query that RLS
silently zeroed out (`select array_agg(id) from documents where user_id <>
...`, run as the first user, returns `NULL` under RLS, and `NULL` means
"no filter" to this function) — not a bug in the function. Caught by
cross-checking with the id fetched a different way. Worth remembering when
writing any test that constructs an "other user's data" fixture under RLS:
fetch it before impersonating, not after.

## Phase 2

### D2.1 — Provider preset table corrected against current vendor docs, not the brief

The brief's presets table was written earlier in 2026. Before hardcoding it
into `packages/ai/src/presets.ts`, each entry was re-checked against that
vendor's current (2026-09-17) docs, which caught two real, silent
discrepancies:

- **Together's base URL**: the brief says `https://api.together.xyz/v1`.
  Together's own current docs canonicalize on `https://api.together.ai/v1`.
  `.xyz` still resolves today, but a fresh integration should point at the
  domain the vendor documents as current, not one that merely still works.
- **OpenRouter embeddings**: the brief marks `embeddings: false`. OpenRouter
  has since shipped a stable `POST /api/v1/embeddings` (confirmed against
  `openrouter.ai/docs/api_reference/embeddings`), so it's now a valid
  `AI_EMBEDDING_PROVIDER` choice.

Groq's capabilities (`embeddings: false` — no `/embeddings` route in its
endpoint list) matched the brief and were reconfirmed rather than assumed
correct by inertia.

One deliberate judgment call beyond what either source claims outright:
Ollama's preset keeps `streamUsage: false` even though its OpenAI-compat
layer accepts `stream_options` on some versions. Whether the usage numbers
it reports back are trustworthy varies across the many local model
runtimes people run, and silently trusting a possibly-wrong real number is
worse than always falling back to `gpt-tokenizer` estimation (which is
explicitly flagged via `TokenUsage.estimated`) — so this stays conservative
until there's a concrete version/model matrix to key off instead of a
blanket flag.

### D2.2 — One retry policy for every provider, owned by `retry.ts`, not the SDK's

`OpenAiCompatibleChatModel`/`OpenAiCompatibleEmbeddingModel` construct the
`openai` SDK client with `maxRetries: 0` and wrap every call in this
package's own `withRetry()` (full-jitter exponential backoff, retrying only
`rate_limit` / `unavailable` / `timeout`). This means backoff timing and
which failures are retryable are identical across OpenAI, Groq, Together,
OpenRouter, Ollama, and any `custom` endpoint — a provider swap can't
silently change retry behavior — and `withRetry`'s `sleep`/`random`
injection points make the backoff math itself unit-testable without real
timers (`retry.spec.ts`).

### D2.3 — Every adapter error becomes one `AiError`; nothing outside `openai-compatible/` sees the SDK's shape

`openai-compatible/map-error.ts` is the single seam that translates
whatever the `openai` SDK throws (`APIError` and its subclasses, connection
errors, abort errors) or any other unexpected throw into an `AiError` with
one of eight fixed codes. A repo-wide `no-restricted-imports` rule (added to
`packages/eslint-config/base.js`) blocks importing `openai` anywhere, with a
single override in `packages/ai/eslint.config.js` re-enabling it for
`src/openai-compatible/**/*.ts` — the same boundary Gate 2's
`grep -r "from 'openai'" apps packages --include=*.ts` checks for, now
enforced continuously by lint instead of only at gate-check time. Phase 3's
Nest exception filter maps `AiError.code` to an HTTP status and never needs
to know which vendor actually answered the request.

### D2.4 — Contract tests run identically against the mock models and the real HTTP adapter

`src/contract.ts` defines the behavioral contract every `ChatModel` /
`EmbeddingModel` must satisfy (non-negative usage, exactly one `finish` per
stream, abort handling, descriptor shape) once, and both `MockChatModel`
and `OpenAiCompatibleChatModel` run it — the latter via `msw`'s Node server
stubbing an OpenAI-compatible HTTP endpoint
(`openai-compatible/test-support/msw-server.ts`), so the real adapter is
exercised against realistic request/response shapes (including SSE
streaming with a trailing usage-only chunk) without a live API key or
network call in CI.

Writing the abort-mid-stream test for the real adapter surfaced a genuine
bug, not a test artifact — reproduced independently against a plain Node
`http` server, not just MSW: aborting an in-flight OpenAI-compatible stream
*after* at least one chunk has already arrived does not make the SDK's
`for await` throw. The response body simply ends, so the loop finishes as
if the stream completed normally. `chat-model.ts`'s `stream()` previously
only recognized an abort in two places — the per-chunk `signal.aborted`
check at the top of the loop, and the `catch` block around the loop — both
of which assume the abort surfaces as either a check hit before the next
chunk or a thrown error. Neither happens in this case, so the post-loop
fallback (used when the provider never sent a usage chunk) was reporting
whatever `finishReason` happened to be set from the last processed chunk —
`"other"` here — instead of `"aborted"`, and estimated usage as if the
response had completed normally. Fixed by re-checking `opts.signal?.aborted`
at that fallback site and reporting `"aborted"` there too, so an abort is
never misreported as a normal finish just because of exactly when the
underlying connection happened to close relative to the last chunk.

### D2.5 — `pnpm ai:check` (`apps/api/src/cli/ai-check.ts`) as the manual verification step

Config resolution has its own exhaustive unit tests (`config.spec.ts`), but
nothing in the automated suite makes a real network call to a real
provider — deliberately, so `pnpm test` stays fast, deterministic, and
runnable with no API keys in CI. `ai:check` is the manual bridge: it loads
the same root `.env` `apps/api` boots with, resolves config through the same
`createAi()` application code uses, prints the resolved
provider/model/base URL with the API key masked, then makes one real
1-token chat completion and one real 1-input embedding call and reports
latency, finish reason, dimensions, and whether usage was provider-reported
or estimated. On failure it prints the `AiError` code plus a short,
code-specific remediation hint (bad key, wrong model name, unreachable
base URL, etc.) instead of a raw stack trace. Verified against all three
outcomes: the default keyless mock config (passes, ~0ms), a provider
missing its required API key (fails at config-resolution, before any
network call), and an unreachable `custom` base URL (fails at the chat
step with `unavailable` and the connection-refused detail).

### D2.6 — Independent re-validation found `stream()` silently never retried, fixed

After the initial Phase 2 push, ran a second, independent validation pass
(same standard as D1.5): fresh `git clone` of the pushed commit, `pnpm
install --frozen-lockfile` (confirming the lockfile generated on a
different machine truly matches `package.json`, not just "happened to
install" with `--no-frozen-lockfile`), then the full `pnpm lint /
typecheck / build / test` and `pnpm ai:check` from scratch, plus a
skeptical, from-scratch adversarial read of every non-test file in
`packages/ai/src` — deliberately not trusting the first pass's own tests
as proof of correctness, the same way D1.5 went looking for gaps Gate 1's
literal checklist didn't cover.

That read caught a real, silent bug: `OpenAiCompatibleChatModel.complete()`
maps the OpenAI SDK's raw error to an `AiError` *inside* the function
passed to `withRetry()`, so `withRetry`'s `isAiError(error) &&
error.retryable` check sees the mapped error and retries correctly.
`stream()`'s initial `create()` call had no such mapping — the raw SDK
error (e.g. `OpenAI.RateLimitError`) reached `withRetry` directly,
`isAiError()` returned `false` for it every time, and `withRetry` gave up
after exactly one attempt regardless of `AI_MAX_RETRIES`. The mapping to
`AiError` only happened afterward, in `stream()`'s outer `catch`, by which
point the retry decision had already been made. Net effect: streaming
requests silently never retried on `rate_limit` / `unavailable` /
`timeout`, while non-streaming `complete()` calls did — a real functional
gap between the two code paths that the existing test suite didn't catch,
because the only retry-specific tests exercised `complete()` and
`retry.ts` in isolation, never `stream()`'s retry behavior specifically.

Fixed by wrapping `stream()`'s initial `create()` call in the same
try/mapOpenAiError pattern `complete()` already uses, so both code paths
reach `withRetry` with an already-classified `AiError`. Added two
regression tests to `chat-model.spec.ts`: one drives a fake provider that
returns two `429`s before succeeding and confirms `stream()` actually
retries and reports the eventual successful text; the other confirms
`maxRetries: 0` still gives up after exactly one attempt (so the fix
didn't accidentally make retries unconditional). Verified the first test
fails against the pre-fix code (confirmed by temporarily reverting just
`chat-model.ts` and re-running) and passes against the fix, so it's a real
regression test and not one that would pass either way.

Separately, this pass also closed a gap in the `no-restricted-imports`
lint rule from D2.3: that rule's `paths` option only matches static
`import ... from "openai"` / `export ... from "openai"` — it does not
catch a dynamic `import("openai")` or `require("openai")`, and neither of
those forms uses the word `from`, so both would also have slipped past
Gate 2's `grep -r "from 'openai'"` check undetected. Added a
`no-restricted-syntax` rule with AST selectors for
`ImportExpression[source.value='openai']` and
`require('openai')`-shaped `CallExpression`s to `packages/eslint-config/base.js`,
with the same directory-scoped override in `packages/ai/eslint.config.js`.
Verified with the same drill as D2.3's rule: a dynamic import outside
`openai-compatible/` now errors, the same import inside that directory is
allowed, and the whole workspace still lints clean.

Re-ran the full suite after both fixes (fresh clone, frozen-lockfile
install, lint, typecheck, build, `pnpm test`, `pnpm ai:check`): 81/81
tests pass (79 + the 2 new retry regression tests), Gate 2's grep check
still confined to `packages/ai/src/openai-compatible/**`, and no secrets,
`.env` files, or other committed credentials found in a repo-wide scan.

## Phase 3

### D3.1 — Gate 3 e2e harness: real PostgREST + hand-minted JWTs, not `supabase start`

The dev Mac this project is built on has no Docker or Podman (`supabase
start` fails outright, naming both), so there's no local GoTrue and no way
to test "through the auth API" the way the brief describes literally.

Rather than fake this with a bare pgTAP-style role switch (the Phase 1 Gate
1 approach — see D1.4 — which never goes over HTTP or through a real JWT),
`apps/api/test/e2e/global-setup.ts` builds a genuine, if partial, substitute:
a real PostgREST v12.2.3 static binary (auto-downloaded per-platform by
`apps/api/test/e2e/postgrest-binary.ts` into `.cache/postgrest/`, gitignored)
pointed at an ephemeral `kb_e2e_test` database, a small dependency-free
reverse proxy (`rest-proxy.ts`) that strips supabase-js's fixed
`/rest/v1` path prefix, and hand-minted HS256 JWTs (`jwt.ts`) signed with
the exact well-known secret every bare `supabase start` uses locally
(`super-secret-jwt-token-with-at-least-32-characters-long` — see
`supabase/config.toml`'s closing note). Two real `auth.users` rows are
seeded per run for the CRUD/isolation scenarios.

This is not a weaker test of `AuthGuard` than a real Supabase project would
get: `AuthGuard.verify()` always tries `getClaims()` first (the only path
that ever runs against a real hosted or `supabase start`-with-custom-JWKS
project) and falls back to local HS256 verification only when that throws
— which is also exactly what happens against a bare local `supabase start`,
since it signs with the same shared secret and has no JWKS endpoint either.
Nothing test-only is baked into `AuthGuard` itself; only the *harness*
(PostgREST + minted JWTs instead of a full GoTrue) stands in for
`supabase start`, and it's meant to be swappable for a real Dockerized
stack by anyone who has Docker (point `E2E_POSTGRES_SUPERUSER_URL` at it
and everything else still applies unmodified).

Real limitations, stated plainly rather than hidden: this needs a genuine
local Postgres reachable as a superuser (`E2E_POSTGRES_SUPERUSER_URL`,
default `postgres://postgres:postgres@127.0.0.1:5432/postgres`) — the
harness does not attempt to start Postgres itself, since "start Postgres"
is too platform-specific to do reliably from Node (Postgres.app vs.
Homebrew services vs. a system service differ by OS). And PostgREST
v12.2.3 ships no native darwin-arm64 build; on Apple Silicon the harness
falls back to the x64 build under Rosetta 2 (present on most dev machines
already) unless `brew install postgrest` (or an equivalent) puts a native
binary on `PATH` or at `POSTGREST_BIN` first. Both are documented in
`postgrest-binary.ts`'s own comments and surfaced as clear, actionable
errors rather than a silent hang if either prerequisite is missing.

### D3.2 — `IndexingQueue` is a Phase 3 stub; real processing lands in Phase 4

`documents.service.ts` enqueues an `{ documentId, contentHash, userJwt }`
job into `IndexingQueue` on every create, hash-changing update, and
successful reindex request — but `IndexingQueue` itself
(`apps/api/src/indexing/indexing.queue.ts`) is currently just an in-memory
`Map`, with no consumer. This is a deliberate phase boundary, not an
oversight: the real pipeline (chunk → embed → `replace_document_chunks`)
needs `packages/rag-core`'s chunker, which doesn't exist yet — it's Phase
4's job. Until then, every document sits in `index_status = 'pending'`
(set by `documents.service.ts` itself, not by a consumer) and stays there;
nothing in `IndexingQueue` contacts an AI provider or the database. The
class exposes a `peek()` method explicitly marked "test/inspection hook
only" — the real Phase 4 queue won't need it — which is what
`documents.e2e-spec.ts` uses to verify the hash-gating behavior (a
tags-only update doesn't enqueue a new job; a content/title change does)
without `IndexingQueue` having any HTTP-visible side effect yet to assert
on directly.

### D3.3 — `@typescript-eslint/consistent-type-imports`'s `--fix` silently broke NestJS DI

Caught by actually running the Gate 3 e2e suite for the first time (not by
lint or typecheck, which both stayed green throughout): `AuthGuard`,
`DocumentsController`, and `DocumentsService` all failed to boot with
`Nest can't resolve dependencies` errors for `Reflector`, `DocumentsService`,
`IndexingQueue`, and `DocumentsRepository` respectively.

Root cause: running `eslint --fix` earlier (to clear a batch of
`consistent-type-imports` warnings) rewrote each of those constructor
parameter's imports to `import type { X } from "..."`. ESLint's static
analysis sees a constructor parameter's type annotation as a pure type
position and "helpfully" strips the value import — but NestJS's DI
resolves a constructor-injected dependency from the `design:paramtypes`
array TypeScript's `emitDecoratorMetadata` emits, which only contains a
real class reference when the import is a genuine value import. A
type-only import is erased entirely at compile time, so the emitted
metadata slot for that parameter is empty, and Nest has no way to resolve
it — a failure mode invisible to both `tsc --noEmit` (types are still
correct) and `eslint` itself (the rule doesn't know about
`emitDecoratorMetadata`), and only surfaces at runtime, when the app
actually tries to boot and inject.

Fixed by reverting all four imports to real value imports and adding an
explicit `// eslint-disable-next-line @typescript-eslint/consistent-type-imports`
with a comment explaining why, at each site. No attempt was made to write
a custom lint rule to catch this class of bug generally (out of scope for
Phase 3) — the practical mitigation going forward is: after any
`eslint --fix` run that touches a file with constructor-injected
dependencies, actually boot the app (an e2e test, not just `pnpm build`)
before trusting the fix.

### D3.4 — Zod v4: `.optional()` doesn't short-circuit a `.default()`-bearing schema on `undefined`

Also caught by the Gate 3 e2e suite itself, not by any unit test written
in advance: `documents.e2e-spec.ts`'s empty-patch case (`PATCH` with body
`{}`, expecting 400) got a 200 instead. `DocumentUpdateSchema`'s `tags`
field reused the exact same schema instance as `DocumentCreateSchema`'s
`tags`, which has `.default([])` baked in, wrapped in an extra
`.optional()` for the update schema. The expectation was that
`.optional()` on `undefined` input would short-circuit before the inner
`.default()` ever ran, leaving `tags` genuinely `undefined` in the parsed
output — so the schema's `.refine()` (requiring at least one of
`title`/`content`/`tags` to be present) would correctly reject a body with
none of them. Instead, zod v4's `.optional()` still delegates to the inner
schema on `undefined` input, so the `.default([])` fired anyway, `tags`
came back as `[]` (not `undefined`), and `.refine()`'s condition was
satisfied by a field the client never sent.

Fixed in `packages/shared/src/documents.ts` by splitting the tags schema:
`tagsWithoutDefault` (no default, used by `DocumentUpdateSchema.tags`,
wrapped in `.optional()` there) and only applying `.default([])` directly
on `DocumentCreateSchema.tags` (not further wrapped in `.optional()`,
where the default reliably fires as intended). Added
`packages/shared/src/documents.spec.ts` with a regression test that calls
`DocumentUpdateSchema.parse({})` directly and asserts it throws — this
would have caught the bug at the unit level, well before an e2e run, had
it existed first; it's now the second line of defense alongside Gate 3's
actual empty-patch HTTP test.

### D3.5 — Full verification: fresh state, every gate green

After D3.3 and D3.4's fixes, re-ran the complete pipeline from the current
working tree (not yet a fresh clone — that re-validation pass happens
after the push, following the same D1.5/D2.6 pattern): `pnpm lint`,
`pnpm typecheck`, `pnpm build`, `pnpm test` across every workspace
(`@kb/ai` 81/81, `@kb/shared` 7/7 including the new regression test,
`apps/api` 6/6 unit), `apps/api`'s `pnpm test:e2e` (8/8 — full CRUD
lifecycle, cross-user RLS isolation returning 404 not 403, malformed-id
400, empty-body 400 with field errors, tags-only vs. content-changing
update against the real `IndexingQueue`), and `pnpm ai:check` (mock
provider, both chat and embedding). Confirmed the e2e harness tears down
cleanly (no orphaned PostgREST/proxy processes, `kb_e2e_test` dropped)
after both a passing and (during D3.3/D3.4 debugging) a failing run.

### D3.6 — Independent re-validation found `AuthGuard` never checked the JWT's `role` claim

Prompted by a direct "is Phase 3 really done, without gaps or bugs"
request — the same standard as D1.5/D2.6's independent re-validation
passes, done from a truly fresh `git clone` of the pushed commit (not the
working tree that built it), with a skeptical read against the brief's
literal Phase 3 checklist rather than trusting Gate 3's four bullet
points as the full picture.

Two things stood out immediately: `AuthGuard`'s local fallback doesn't
call `supabase.auth.getUser()`, which is what the brief literally names
("fall back to getUser if the local stack uses symmetric HS256"), and
neither verification path (`getClaims()` nor the local fallback) ever
checked the token's `role` claim. The first is a deliberate, now-documented
deviation (see the updated `auth.guard.ts` docstring): `getUser()` needs a
running Supabase Auth server to call, and this environment has none at
all (D3.1), so it would fail the same way `getClaims()` does, just for an
unrelated reason. The second is a real bug, and worth demonstrating
concretely rather than trusting the theory: a JWT hand-minted with
`role: "service_role"` and the correct (well-known local) signing secret
was accepted by `AuthGuard` exactly as if it were a normal user's token,
because nothing ever compared the `role` claim against `"authenticated"`.

A forged `service_role` token handed to `createUserScopedClient` makes
PostgREST switch the underlying Postgres role to `service_role` — which
has `bypassrls` (see `apps/api/test/e2e/bootstrap.sql` and a real
project's platform setup). In *this* schema specifically, the probe came
back `403`, not a data leak, only because the Phase 1 migration's grants
(`supabase/migrations/*.sql`) never gave `service_role` table privileges
on `public.documents` in the first place — an incidental mitigation, not
a designed one, and one a future migration could easily undo (a Phase 4
background indexing worker, for instance, is a plausible reason to grant
`service_role` broader access later). `AuthGuard` itself provided no
defense-in-depth against this at all, which directly undermines the
project's own stated invariant: "no service-role access in apps/api."

Fixed by rejecting any token whose `role` claim isn't `"authenticated"`
in both `verifyViaGetClaims` and `verifyViaLocalSecret` — a cheap check
that makes the "no service-role access" guarantee hold regardless of what
any given schema's grants happen to allow. Added a regression test
(`documents.e2e-spec.ts`, "rejects a non-'authenticated' role JWT") that
mints both a `service_role` and an `anon` token with the real owner's own
`sub` claim (so the only thing wrong with either token is its role) and
asserts both get `401`; confirmed against the pre-fix code that the
`service_role` case actually returns something other than 401 (`403`, per
the probe above) before trusting the fix.

The same re-validation pass also found real, if lower-severity, test
coverage gaps against the brief's Phase 3 endpoint list: `GET /documents`
query search (`q`, `tag`), pagination (`limit`/`cursor`), and
`POST /documents/:id/reindex` were all implemented but had zero test
coverage — Gate 3's four bullet points don't mention them, but the brief's
own endpoint list does. Added `documents.e2e-spec.ts` cases for all three:
`q` search including a literal `%` in the search term (proving
`escapeIlike` actually works, not just that it exists), `tag` filtering,
two-page pagination that covers a seeded set exactly once with no overlap,
and `reindex`'s `409` (not-failed document) / `404` (nonexistent, and
cross-user via RLS) responses. Also added a `400` case for a
completely malformed (non-JWT-shaped) bearer token, which was previously
only implicitly covered.

Re-ran the full pipeline from the same fresh clone after all fixes:
`pnpm lint` / `typecheck` / `build` / `test` clean across every
workspace, and `apps/api`'s `pnpm test:e2e` at 12/12 (the original 8 plus
the 4 new cases above).

### D3.7 — `documents.service.ts` had a literal raw NUL byte embedded in its source

Found on a follow-up, even more skeptical pass (the person asked "is this
really fixable?" about a `file`/`grep` classification oddity flagged
independently): `computeContentHash`'s `.update(" ")` call — read and
documented earlier (D3.4's writeup, and this file's own D3.2) as using a
plain space separator — actually contained a literal raw `0x00` byte
inside the string literal, not the printable space character it looked
like in every editor/terminal rendering along the way. `file` classified
the whole file as `data` (binary) because of it; `grep -n` on the file
warned "binary file matches" for the same reason. Neither `tsc`,
`eslint`, `nest build`, nor any test ever caught it, because a raw NUL
byte inside a string literal is completely valid TypeScript — it compiles
and runs identically to the properly-escaped `"\0"` — so nothing in the
pipeline had a reason to flag it. It's likely how it got there in the
first place: the original design was a null-byte separator (deliberately
chosen so it can never collide with real title/content text), and at
some point during authoring the two source characters `\` and `0` came
out as one raw control byte instead.

Confirmed there was zero behavioral drift before fixing it: computed the
hash of the same `(title, content)` pair two ways — once via Node with
the properly-escaped `"\0"`, once via Python writing the identical raw
`0x00` byte directly — and both produced the exact same SHA-256 digest.
So this was a pure source-hygiene bug, not a hash/behavior bug: nothing
depended on today's exact hash values anyway (no real data exists yet),
and `documents.service.spec.ts`'s existing boundary-collision test
(`("a","bc")` vs. `("ab","c")`) already covered the actual thing a
separator is for.

Fixed by replacing the raw byte with the `\0` escape sequence (verified
byte-for-byte identical resulting hash, see above). Added
`no-embedded-control-bytes.spec.ts`, modeled directly on the existing
`no-service-role-key.spec.ts` pattern: it scans every non-spec `.ts` file
under `apps/api/src` for any raw control byte other than
tab/newline/carriage-return and fails the build if one is found — so this
exact class of bug (valid, compiling, passing-every-existing-test, but
literally not text) gets a real automated check instead of depending on
someone noticing `file` or `grep` complain about a specific source file.

## Phase 4

### D4.1 — Chunker: markdown-aware, token-budgeted, offset-tracked, pure

`packages/rag-core/src/chunker.ts`'s `chunkDocument(title, content, opts)`
is the first real content of `@kb/rag-core` (Phase 0 only scaffolded the
package). Pure and framework-free — no I/O, no Nest, no Supabase client —
so it unit-tests in isolation and is reusable from a future worker
process without dragging apps/api along.

Pipeline: normalize line endings (`\r\n`/`\r` -> `\n`) while keeping an
index map back to the ORIGINAL string, so every chunk's `charStart`/
`charEnd` describe the document exactly as it was saved, not the
normalized copy — verified with a dedicated CRLF round-trip test, not
just an LF one. Parse blocks (ATX headings H1-H6, fenced code, GFM
tables, plain text runs) with a heading stack producing each block's
`headingPath` ("Document Title > H1 > H2 > ..."); the title is
deliberately the root of every path, matching `computeContentHash`'s own
title-feeds-the-embedding rationale (documents.service.ts) — a title-only
edit already changes the hash, and now it also changes every chunk's
heading path text, so the two stay conceptually consistent. Code blocks
and tables are atomic (never split) unless a single one alone exceeds
`RAG_CHUNK_MAX_TOKENS`, in which case it's split by line as a last
resort — both behaviors have their own test. Everything else recursively
splits blank-line -> newline -> sentence-end -> whitespace, only as far
as needed to get under budget, then greedily packs back up to
`RAG_CHUNK_TOKENS` (450 soft), capped at `RAG_CHUNK_MAX_TOKENS` (600
hard); a heading-path change always forces a new chunk, so one chunk
never straddles two sections.

Real token counts throughout, via `gpt-tokenizer`'s `countTokens` — not
a character-count approximation — because the whole point of the budget
is to bound what an embedding call (and eventually a chat prompt) will
actually cost/accept. One subtlety that cost a failing test before it was
fixed: packing decisions can't just sum each piece's own token count in
isolation, because the separator text between two packed pieces (a blank
line, etc.) and BPE merges across a piece boundary both still cost real
tokens once they're part of one contiguous chunk. `packPieces` checks the
token count of the ACTUAL candidate slice (`normalizedText.slice(start,
candidateEnd)`), not a running sum, and the overlap step (next paragraph)
has its own binary-search safety net for the same reason — both are
covered by "never exceeds the hard max, even with overlap applied".

Consecutive chunks under the SAME heading path carry `RAG_CHUNK_OVERLAP_
TOKENS` (60) of trailing context from the predecessor, cut at a sentence
boundary where one is found within budget; overlap never crosses a
heading boundary (a new section starts clean) and is shrunk — down to
zero if necessary — so a chunk plus its overlap still never exceeds the
hard max. A trailing chunk under `minTrailingTokens` (80) merges into its
predecessor rather than being left as a tiny orphan; this runs at every
heading-path boundary, not only at the very end of the document (several
tiny trailing chunks in a row cascade-merge, walking backward), and never
merges across a heading boundary either.

All of the brief's specified cases are covered in `chunker.spec.ts`:
empty document (0 chunks), short document (exactly 1), headings
propagating into `headingPath`, a code block never splitting (plus the
oversized-block line-split fallback as its own case), char-offset
round-tripping (LF and CRLF), overlap actually appearing in the next
chunk, the hard max never being exceeded, small-trailing-chunk merging,
and chunks never mixing content from two different heading paths.

### D4.2 — `IndexingQueue`: p-queue, concurrency 2, per-document "latest job wins"

Replaced the Phase 3 stub (D3.2) with the real implementation the brief
specified: an in-process `p-queue` (concurrency 2 globally) keyed by
document ID. The subtlety is what "keyed by document ID" has to mean once
jobs can actually take real time (an HTTP call to an embedding provider,
not an instant mock): a document ID occupies exactly ONE p-queue slot for
the entire time it has work pending, not one slot per `enqueue()` call.
`enqueue()` while a document's slot is already active just replaces
`pendingByDocument.get(documentId)` with the newer job; the running task
loops (`runForDocument`) and picks that up once its current pass
finishes, rather than a second task being scheduled. An in-flight
embed/DB call is never cancelled — there's no safe way to cancel a
network call mid-flight — so "latest job wins" means a stale intermediate
job for the same document simply never gets its own processor run, not
that an in-flight one gets interrupted. `replace_document_chunks`'s own
`content_hash` guard (unchanged since Phase 1) is the second,
belt-and-suspenders layer in case a slow stale write somehow still lands
after a newer one.

The processor itself (`IndexingService`) is late-bound via
`queue.setProcessor()` called from `IndexingService`'s own constructor
(via `onModuleInit`), not constructor-injected into the queue — Nest
can't construct `IndexingQueue` and `IndexingService` if each needs the
other as a constructor argument. This is the same late-binding pattern
the brief's own circular-DI guidance describes, and avoids `forwardRef()`
entirely. Note this means `IndexingService` is never actually injected by
anything else in the app — it's listed in `IndexingModule`'s `providers`
purely so Nest constructs it (and runs its `onModuleInit`) at boot; Nest
eagerly instantiates every provider in a module's `providers` array
regardless of whether anything else injects it, which is exactly what's
relied on here.

### D4.3 — Indexing pipeline error handling: `AiError` messages are safe to show; everything else isn't

`IndexingService.process()`'s catch-all writes `index_error`, which IS
user-facing (`documents.repository.ts` exposes it on the DTO). `AiError`
(`@kb/ai`, Phase 2) is documented as deliberately safe to surface —
adapters must never leak a raw SDK/HTTP error through it — so an
`AiError`'s own `.message` is used verbatim. Anything else (a Postgres
error, a bug) might contain internal detail that shouldn't reach a user,
so it's logged in full via Nest's `Logger` (server-side only) and
replaced with a generic "Indexing failed unexpectedly. Try reindexing."
before it's written to the row. Both `markFailed` and the new
`markIndexing` (set right before processing starts, giving `index_status`
a real, visible 'indexing' state instead of jumping straight from
'pending' to 'ready'/'failed') are guarded by `content_hash`, the same
principle as `replace_document_chunks`'s own guard: a stale write for an
already-superseded version of the document is a silent no-op, never a
clobber.

### D4.4 — No boot-time startup sweep: RLS makes one impossible without a service-role key, so recovery is lazy and per-user instead

The brief's own trade-off note (an in-process queue loses all pending
work on restart) called for "a startup sweep that re-enqueues documents
stuck in pending/indexing." A literal boot-time, `OnApplicationBootstrap`
sweep turns out to be impossible within this app's own architecture,
not just inconvenient: every Supabase query in apps/api runs through a
per-request client scoped to one user's JWT, because RLS is the only
authorization boundary here — there is deliberately no service-role
client anywhere in this app (reaffirmed as recently as D3.6, which exists
specifically because a forged service-role-claiming JWT is dangerous). A
sweep running at boot has no user's JWT to run as, and "find every
stuck document across every user" is exactly the kind of cross-user query
RLS exists to prevent from an ordinary client. The only way to make a
literal boot-time sweep work would be to give apps/api a service-role
client (or an equally privileged narrower role) — a real architecture
change with real security implications, not something to reach for
quietly just to tick off a resiliency nice-to-have.

Instead, `DocumentsService.resumeStuckIndexing()` runs lazily, on every
`list()` and `getById()` call, scoped to whichever user is making that
request, using THEIR OWN already-verified JWT (`auth.jwt` — the exact
same client `AuthGuard` already built for this request). It queries only
that user's own `'pending'`/`'indexing'` documents (RLS-scoped, so it
structurally cannot see anyone else's) and re-enqueues each one that
isn't already active in this process's `IndexingQueue`
(`queue.isActive()`), which is what makes it safe to call on every
request rather than only after a detected crash — re-enqueuing a
document that's already being processed right now is a cheap, correct
no-op, not a duplicate side effect. In practice this means: any document
stuck by a server restart gets automatically picked back up the next
time its owner does essentially anything with their documents (opens
their list, opens the document itself) — which for an interactive
product is close to immediate. The one honestly-acknowledged residual
gap: a document whose owner never makes another request stays stuck
until they do. That's the trade-off actually being made here, and it's a
significant improvement over "stays stuck forever, unconditionally,"
without ever introducing a new privileged credential.

### D4.5 — Gate 4 e2e: real pipeline end-to-end, deterministic failure injection via `overrideProvider`, not a hook in `@kb/ai`

`documents.e2e-spec.ts`'s existing "full CRUD lifecycle" test previously
asserted hash-gated indexing by reaching into the running app's
`IndexingQueue` instance and calling a test-only `peek()` method (Phase
3, since there was no real processing yet to observe any other way).
That approach stops being meaningful once real processing exists:
`peek()`'s "the latest job still queued for this document" becomes "not
yet started," which is usually already empty by the time a test can
check it, since the mock embedder finishes in milliseconds. Rewrote those
assertions to poll the same HTTP-visible fields a real client would see
(`GET /documents/:id`'s `indexStatus`/`chunkCount`/`indexedAt`) via a
small `waitFor()` helper (`test/e2e/wait-for.ts`) — a tags-only update
now asserts `indexedAt` is UNCHANGED (proving no job was enqueued, not
just that the hash "looks" the same), and a content update asserts
`indexedAt` changes and `indexStatus` returns to `'ready'`.

Added `indexing.e2e-spec.ts` for the pipeline-specific cases the brief
called for: a basic document's `chunkCount` matches calling
`chunkDocument()` directly with the same title/content (i.e., the API's
real output equals the pure function's real output, not just "some
positive number"); two content updates fired back-to-back without
waiting resolve to the SECOND update's content and chunk count (proving
"latest job wins" end-to-end, not just at the queue's own unit level);
and a forced embedding failure leaves the document `'failed'` with a
non-null `indexError` while its OLD `chunkCount`/`indexedAt` are
completely untouched (proving a failed reindex can never lose already-
indexed content) and that a `'failed'` document (only) is eligible for
`POST /documents/:id/reindex`.

The forced failure needed a way to make embedding fail on demand,
deterministically, for exactly one document, without touching
`@kb/ai` itself just to add a test-only trigger. Solved with a small
`ControllableEmbeddingModel` (test-file-local) that wraps the real
`MockEmbeddingModel` and throws an `AiError` only when an embed() input
contains a sentinel string, otherwise delegating straight through —
installed via Nest's own `overrideProvider(EMBEDDING_MODEL).useValue(...)`
on the test module, a standard, first-class Nest testing mechanism, not a
production code change or a hidden test hook.

Re-ran the full pipeline from a fresh clone after all of Phase 4's
changes: `pnpm lint` / `typecheck` / `build` / `test` clean across every
workspace (`@kb/rag-core` now has its own real test suite, matching the
`@kb/shared`/`@kb/ai` pattern), and `apps/api`'s `pnpm test:e2e` at 15/15
(12 in `documents.e2e-spec.ts`, 3 new in `indexing.e2e-spec.ts`).

### D4.6 — Independent re-validation found a real bug: a usage-logging hiccup could discard a successful embed pass

Asked, after Phase 4 was "done": "is this really done, without gaps or
bugs?" — the same standard applied to Phase 3 (D3.6/D3.7), not just
re-running the existing suite. From a fresh clone, re-read every new file
adversarially against what it claims to do, wrote small standalone probe
scripts to test specific hypotheses against the built output (not just
reasoning about the code), and found one real bug plus one real,
if minor, correctness bug, plus one real test-coverage gap:

**The bug (confirmed with a standalone script before touching any
code):** `IndexingService.embedChunks()` called
`repository.recordUsage()` — an insert into `ai_usage_events`, a purely
observational accounting record — INSIDE the same function, BEFORE
returning the shaped chunk payload, and the whole call was inside
`process()`'s one try block. A probe script instantiating the real
`IndexingService` with a `recordUsage` that throws (simulating a
transient DB hiccup) proved the exact failure mode: `embed()` succeeds,
`recordUsage()` throws, and the job ends by calling `markFailed` — never
even attempting `replace_document_chunks`. A perfectly good embed pass
(the expensive, actually-important part) got thrown away and the
document was marked `'failed'`, purely because a side-effect insert had
a bad moment. This is a real resilience gap: the accounting write was
treated as equally critical as the actual indexing write, when it
obviously isn't — a user's document shouldn't fail to index because a
usage-logging row didn't make it in.

Fixed by moving `recordUsage` to run AFTER `replaceChunks` (not before),
and wrapping it in its own try/catch that only logs a warning and never
rethrows (`recordUsageBestEffort`) — usage is still recorded even when
`replaceChunks` returns `false` (a stale write skip), since the `embed()`
call already happened and already cost real tokens by that point
regardless of what happens to the write afterward; a `recordUsage`
failure can now never affect whether the document ends up `'ready'` or
`'failed'`. Added `indexing.service.spec.ts` (a new file — Phase 4's
`IndexingService`/`IndexingRepository` had zero unit-level tests before
this, only e2e coverage) with the failing-probe scenario as a permanent
regression test, plus checks for the correct call order, that usage is
still recorded on a stale-write skip, and that a genuine `embed()`
failure still correctly marks the document failed (proving the fix
didn't accidentally swallow real failures too). Also extended
`indexing.e2e-spec.ts`'s basic-doc test to actually query
`ai_usage_events` (via a raw client scoped with the test user's own JWT,
reading under real RLS) and assert a row lands there — this table wasn't
being asserted on by any test at all before, despite `recordUsage` being
a real, documented part of the pipeline.

**The minor bug:** a markdown heading line with no title text after the
hashes (`"## "`, or `"## ##"` — hashes on both sides, nothing between)
is a malformed but valid ATX heading per `HEADING_RE`, and used to
survive into `headingPath` as a dangling empty segment —
`"Handbook > Doc Title > "` instead of `"Handbook > Doc Title"`.
Confirmed with a probe script before fixing. Fixed by filtering
empty-text segments out of the joined path in `assignHeadingPaths`
(the heading still correctly acts as a section boundary — still pops/
pushes the stack, still forces a new chunk — it just contributes no text
of its own to the path). Added a regression test in `chunker.spec.ts`.

**Also checked and ruled out**, so as not to leave them as open
questions: whether embedding vectors with very small components
(scientific notation, e.g. `1e-07`, which is how `Number.prototype.
toString()` renders a sufficiently small float) would break
`replace_document_chunks`'s `::extensions.vector` cast — confirmed via a
direct `psql` probe that pgvector's text parser accepts exponential
notation, so this was never actually a risk; and whether a heading-like
line (`"# ..."`) INSIDE a fenced code block gets mistaken for a real
heading — confirmed via a probe script that it does not (block parsing
correctly treats fence interiors as opaque).

Re-ran the full pipeline from a fresh clone after all fixes: `pnpm lint`
/ `typecheck` / `build` / `test` clean across every workspace (`apps/api`
now at 11 unit tests, up from 7, via the new `indexing.service.spec.ts`),
and `pnpm test:e2e` at 15/15 again (same test count — the new
`ai_usage_events` assertion was added to an existing test, not a new
one).

### D4.7 — Trailing-merge loop could still overflow the hard token cap; fixed a real bug surfaced by an externally-sourced claim

Given a specific, falsifiable claim to check — not asked to fix anything,
only to validate it — that the trailing-merge loop in `chunker.ts` (the
step right after the trim pass, walking backward and merging small
trailing chunks into their predecessor) had no check that the *merged*
result stayed within `maxTokens`, only a check on the small chunk's own
isolated token count against `minTrailingTokens`. Investigated read-only,
from a fresh clone: read the loop's actual code (confirmed no
`maxTokens` check existed anywhere in it), then wrote standalone probe
scripts sweeping a near-budget fenced code block followed by a short
closing sentence at production defaults (`targetTokens 450 /
maxTokens 600`). The sweep reproduced real overflow — e.g. a 36-line
code block (580 tokens) plus a 14-word tail merged into a single
602-token chunk, and the sweep found overflow up to 618 tokens against
the 600 cap. A follow-up probe isolated a single-chunk case to rule out
chunk-overlap as the cause (no predecessor chunk existed to draw overlap
from, yet the overflow still occurred) — the merge loop itself was the
only remaining explanation. Reported the claim as accurate, with no
changes made, per the explicit "just and only validate this claim"
instruction.

Asked next whether it could be fixed, then given explicit go-ahead to
fix it. This is the exact same class of bug as `packPieces`'s own fix
above (D4.1): a token-budget decision was being made by checking a
piece's own isolated token count instead of the real, final concatenated
text's actual token count — separator text between the small chunk and
its predecessor, plus any BPE merge across the join, both cost real
tokens once the two are one contiguous chunk, and neither is visible to
a check that only looks at the small chunk on its own.

Fixed by computing `mergedTokens` — `countTokens()` on the actual
prospective merged slice (`prevChunk.start` to `chunk.end`), not a sum of
the two pieces' separate counts — and skipping the merge entirely
(leaving the small trailing chunk standing on its own) whenever that
would exceed `maxTokens`. The hard cap must never be sacrificed just to
avoid leaving a small trailing chunk unmerged; a small chunk by itself is
still a perfectly valid chunk. Verified the fix directly: re-ran the
exact same parameter sweep that had previously found overflow up to 618
tokens, and it now found none (max observed: exactly 600, never over),
while confirming merging still functions normally for legitimate small-
trailing-chunk cases at more moderate settings (not an accidental no-op
regression).

Added a permanent regression test to `chunker.spec.ts` reproducing the
36-line-code-block-plus-14-word-tail scenario, and proved the test
itself was real before trusting it: ran it against the pre-fix code
first and confirmed it failed at exactly 602/600 (matching the
originally-reported reproduction), then confirmed it passes against the
fix. Re-ran the full pipeline from a fresh clone: `pnpm lint` /
`typecheck` / `build` / `test` clean across every workspace, and
`pnpm test:e2e` still 15/15 — nothing else regressed.

## Phase 5

### D5.1 — Prompt design: sources live in the system message, not the latest user turn

The brief's Phase 5 spec is explicit about the message shape: `[system
(rules + <sources> block), ...trimmed history, user (the bare
question)]` — retrieved context belongs in the system message, not
stuffed into the final user turn the way a naive RAG implementation
often does. `buildChatMessages` (`packages/rag-core/src/prompt.ts`)
follows this literally: `buildSystemPrompt` renders one fixed rules
block (verbatim from the brief, snapshot-tested in `prompt.spec.ts` so a
change to it is a deliberate, reviewed change to the assistant's
behavior) followed by a `<source id="..." title="..." section="...">`
per retrieved chunk, and the final user message is always just the raw
question text, nothing appended.

This created a real design tension with `packages/ai/src/mock/
mock-chat-model.ts`, whose doc comment (written in Phase 2, before
Phase 5's actual prompt shape existed) assumed "retrieved context +
question would live in the latest user message." Resolved in favor of
the brief (the stated source of truth) rather than the stale comment:
`MockChatModel` still works correctly either way, since its citation
generation derives `[S1]`-style markers from whatever text is in the
latest user message, and in Phase 5's real shape that's the bare
question — a one-sentence question still deterministically produces one
`[S1]`-cited sentence, which is exactly what `chat.e2e-spec.ts` relies on
being deterministic. The mock's own doc comment gets corrected in this
phase's diff rather than left misleading.

Two smaller decisions in the same file: `escapeXmlAttribute` escapes
`&`/`"`/`<`/`>` in a source's `title`/`section` attributes but
deliberately leaves the chunk `content` body itself unescaped, since the
brief's literal template renders content as raw text and the real
security boundary is the system rule telling the model to treat sources
as data plus `citations.ts` validating every streamed marker against the
real source-id set — not text-level escaping of prose that's meant to be
read as prose (a title containing a literal `>` now renders as `&gt;` in
the snapshot test, confirming the escaping works, not a bug). And
`stripCitationMarkers` strips `[S<digits>]` markers out of a past
assistant turn before it goes back into history, so the model never
sees its own citation bracket-noise as something to imitate — used both
by `buildChatMessages`'s history trimming and by `retrieval.service.ts`
before feeding history into the (separate, "cheap") query-rewrite call.

### D5.2 — Citation stream parser buffers only the minimal ambiguous bracket prefix

A real streaming `ChatModel.stream()` delivers text in arbitrary
chunk boundaries that have nothing to do with where a `[S1]`-style
marker falls — `"[", "S", "1", "]"` in the worst case, split across four
separate deltas. `createCitationStreamParser` (`packages/rag-core/src/
citations.ts`) handles this by holding back only the smallest possible
suffix of the buffer that could still grow into a complete marker (a
trailing `[`, `[S`, `[S1`, etc. — anything matching `/^\[S?\d*$/`), and
emitting everything else immediately, so the SSE layer streams text to
the browser with the least possible added latency rather than batching
whole words or sentences. `citations.spec.ts` tests this by splitting a
message containing several markers at *every* possible character offset
and asserting the reassembled output is identical regardless of split
point — the brief's own bar for this component.

A complete marker is validated against the real, current turn's
source-id set (assigned by `retrieval.service.ts`, never anything the
model or a document's own text could invent) as it's parsed; an id that
doesn't match a real source is silently stripped from the emitted text
rather than passed through — a hallucinated or copied-from-document-text
`[S99]` must never reach the browser looking like a real, clickable
citation. `chat.service.ts` logs (but doesn't surface to the user) how
many markers were dropped per turn.

### D5.3 — Retrieval: offset-based near-duplicate merging, and "always keep the first source" budgeting

Two chunks from the same document with consecutive `chunk_index` values
are the only case the chunker's own overlap step (Phase 4) can ever
produce shared text between — so `RetrievalService.mergeAdjacent` merges
exactly that case (same `document_id`, consecutive `chunk_index`) into
one source block, by re-slicing the FULL document content at the
combined `[min(charStart), max(charEnd))` offset range, rather than
text-diffing the two chunks' content to find and remove the overlap.
Offset-based merging is exact and cheap; text-diffing would be
approximate and slower for a case whose shape is already fully known
from the chunker's own contract. Only merged (multi-chunk) blocks need
this re-fetch — a single-chunk block's content is already exactly
`document_chunks.content`, so `packContext` only calls
`findContentByIds` for the document ids that actually need it.

Context packing then applies the `RAG_CONTEXT_TOKENS` budget by walking
merged blocks in score order, always keeping at least the first
(highest-scoring) block even if it alone exceeds the budget — the same
"never end up with nothing just because the single best match happens to
be large" principle `prompt.ts`'s own history trimming already uses.
`sourceId`s (`S1`, `S2`, ...) are assigned in this final, post-budget,
score-sorted order, which is also the order `citations.ts` validates
streamed markers against and the order `chat-events.ts`'s `sources`
event lists them in.

Query rewriting (`maybeRewriteQuery`) is a separate, deliberately
"cheap" `chatModel.complete()` call — only the last 6 history turns, a
5s `AbortController` timeout, and any error/timeout/empty-output result
falls back to the raw question rather than blocking or failing
retrieval. A successful rewrite is recorded as its own `query_rewrite`
usage event (best-effort, see D5.5), separate from the turn's own `chat`
usage event, so cost attribution between "understanding what was asked"
and "answering it" stays visible.

### D5.4 — `UsageRepository` duplicates `IndexingRepository.recordUsage`'s logic rather than sharing it

`apps/api/src/common/usage.repository.ts` is a small, deliberate copy of
the same insert-into-`ai_usage_events` logic `IndexingRepository` (Phase
4) already has, rather than extracting a shared base class or having one
depend on the other. The two call sites (`query_rewrite`/`chat` events
from retrieval and chat; `embedding`/`chunking`-adjacent events from
indexing) belong to genuinely different features with no other coupling
between them today, and the insert itself is a handful of straight-line
lines — not enough shared complexity to justify the indirection a shared
abstraction would cost, especially given the two could reasonably drift
(a future phase adding per-operation fields to one shouldn't force a
change to the other). Revisit if a third near-identical call site shows
up.

### D5.5 — Chat orchestration: transport-agnostic `runTurn`, `AiError`-safe messaging, best-effort usage recording

`ChatService.runTurn` is the one place a full turn is driven — get/
create the conversation, retrieval, prompt, stream, citation resolution,
persistence, usage — and is deliberately transport-agnostic: it takes an
optional `onEvent` callback and an optional `AbortSignal`, and returns
the same `ChatTurnResult` either way. `POST /chat/stream`'s controller
wires `onEvent` straight to SSE writes; `POST /chat` (the brief's
non-streaming equivalent) calls it with no `onEvent` at all and just
reads the returned result. This means there is exactly one place this
orchestration logic can drift from itself between the streaming and
non-streaming surfaces, rather than two similar-but-not-identical
implementations.

Error messaging reuses the `AiError`/`isAiError()` split
`http-exception.filter.ts` established in Phase 3: an `AiError`'s own
message is safe to show (it's already a friendly, provider-agnostic
string); anything else becomes a fixed generic message
("Something went wrong generating a response. Try again.") so a raw
upstream/DB error string can never leak into a persisted assistant
message or an SSE `error` event. A failure during retrieval, or mid-
stream, is persisted as a `'error'`-status assistant message with
whatever partial content and citations had already been produced (not
discarded) — `persistError` is the one path both cases go through.

Usage recording is best-effort, the exact D4.6 pattern (log-and-swallow,
never rethrow) applied twice more here: `recordChatUsageBestEffort` after
a successful stream, and `recordRewriteUsageBestEffort` after a
successful query rewrite. A hiccup logging cost must never turn an
otherwise-successful answer into a failure, same reasoning as D4.6's
original fix. The no-context path (`finishNoContext`, when retrieval
finds zero sources) records no chat usage event at all, since no LLM
call was actually made for that turn — asserted directly in
`chat.e2e-spec.ts`, not just left as an implication.

### D5.6 — Real bug found while building the Gate 5 abort test: `req.on("close")` never fires here; `res.on("close")` does

`ChatController.stream`'s SSE handler originally wired the abort signal
to `req.on("close", () => controller.abort())` — the commonly-documented
way to detect a client disconnecting mid-response in Express. Writing
the Gate 5 e2e test for "aborting mid-stream persists status 'aborted'"
(a real client destroying its socket right after reading the `start`
event) surfaced that this handler never fires at all on this stack
(Express 5.2 / Node 22): the persisted message consistently ended up
`'complete'`, not `'aborted'`, and a temporary debug log confirmed
`req.on("close")`'s callback simply never ran, even on a hard
client-side `req.destroy()`.

Switched to `res.on("close", ...)` — the `ServerResponse`'s own
lifecycle, which Node's docs describe as firing when "the response is
completed, or its underlying connection was terminated prematurely" —
and confirmed the same debug log now fires reliably. This is also the
more semantically correct object to listen on regardless of the Express-
version-specific behavior: what actually matters here is "should this
handler keep writing to this response," which is `res`'s lifecycle, not
`req`'s. `chat.controller.ts`'s `@Req()` parameter was removed entirely
once nothing else in the handler needed it. `chat.controller.spec.ts`'s
fake-response double was extended to be a real `EventEmitter` so its own
"aborts when the response closes" test exercises the exact same
`res.on("close")` call the real handler makes, not a different code
path pretending to be equivalent.

### D5.7 — Gate 5 e2e: `ControllableChatModel` (same pattern as D4.5), a real ephemeral port for the abort test, SSE parsed via a custom supertest `.parse()`

`chat.e2e-spec.ts` runs the same real Postgres+RLS+PostgREST harness
Gate 3/4 already built, plus the real hybrid-retrieval RPC (Phase 1) and
real chunker (Phase 4) — the only thing standing in is
`AI_CHAT_PROVIDER`/`AI_EMBEDDING_PROVIDER`'s own default of `"mock"`
(`packages/ai/src/config.ts`), so no API keys are needed, same as every
prior e2e gate. `MockEmbeddingModel`'s bag-of-words hashing means a
seeded document and a question sharing distinctive vocabulary reliably
clears `RAG_MIN_SIMILARITY`, and `match_document_chunks`'s own `where
... or kw.id is not null` clause additionally lets a real keyword match
through regardless of the semantic score — so no test here depends on
exact similarity numbers, only on shared keywords existing.

The one scenario that couldn't just use the raw `MockChatModel` directly
is the abort test: `MockChatModel.stream()` has no real delay anywhere
in its word-by-word loop, so a client destroying its socket right after
reading the `start` event was, in practice, racing a synchronous
in-process loop it usually lost — an early version of this test observed
`'complete'` instead of `'aborted'` on nearly every run. Fixed the same
way D4.5 fixed the equivalent problem for indexing's forced-failure
test: a small `ControllableChatModel` (test-file-local) wraps the real
`MockChatModel` and, only when a one-shot flag is set immediately before
the test's own request fires, waits a real, generous 300ms before
checking `opts.signal?.aborted` and yielding accordingly — installed via
`overrideProvider(CHAT_MODEL).useValue(...)`, the same standard Nest
testing mechanism D4.5 used, not a production code change. This proves
the real `res.close → AbortController → chatModel.stream(signal)` wiring
end to end over a real socket, without depending on winning a race
against an in-process loop's own speed; the exact same contract is also
covered with zero timing dependency at all by `chat.controller.spec.ts`'s
fake-`res`-close test and `chat.service.spec.ts`'s
`FinishReason:'aborted'` test.

That one test also needed a real listening port (`app.listen(0)`, read
back via `getHttpServer().address()`) rather than supertest's implicit
ephemeral bind, since it drives a raw `http.request` directly so it can
destroy the client socket the instant the `start` event's bytes arrive —
every other test in the file still just uses supertest against
`app.getHttpServer()` as usual, listening or not makes no difference to
those. Reading a full SSE response body with supertest (which doesn't
parse `text/event-stream` out of the box) uses a small custom
`.buffer(true).parse((res, cb) => ...)` that concatenates the raw chunks
and hands them back as one string, then a local `parseSse()` splits on
blank lines and picks out `data: ` lines — the same shape browsers
themselves split an SSE stream on.

### D5.8 — Full verification: fresh state, every gate green

Ran the complete pipeline after Phase 5 landed: `pnpm turbo run lint
typecheck build test --force` clean across every workspace (`@kb/rag-
core` gained 29 new pure unit/snapshot tests across `prompt.spec.ts` and
`citations.spec.ts`; `apps/api` gained `retrieval.service.spec.ts`,
`chat.service.spec.ts`, and `chat.controller.spec.ts` — 53 unit tests
total, up from 11 at the end of Phase 4), and `pnpm test:e2e` at 26/26
(`chat.e2e-spec.ts`'s 11 new scenarios alongside the existing 15 from
documents/indexing), re-run three times in a row to confirm the abort
test in particular wasn't flaky after the D5.6/D5.7 fixes.

### D5.9 — Independent re-validation pass: two real bugs found and fixed

Asked directly "is Phase 5 really done, without gaps or bugs?" after
D5.8 already reported everything green — the same recurring exercise as
D1.5/D2.6/D3.6-D3.7/D4.6-D4.7: a fresh clone of the pushed commit, an
adversarial read of every new file against what it claims to do, and
standalone probes to check specific hypotheses against real behavior
rather than trusting the reasoning alone.

Found two real issues, both confirmed against the fresh clone's actual
current source (not memory of writing it):

1. **`RetrievalService.packContext`'s budget loop used `break` instead
   of `continue`.** Blocks are walked in score order and packed until
   `RAG_CONTEXT_TOKENS` is exhausted; the loop `break`s the instant any
   block fails to fit, which wrongly discards every remaining block too
   — including a smaller, lower-scored one later in the list that would
   still have fit in the leftover budget. Proved it with a standalone
   probe before touching any code: three blocks (A fits, B doesn't, C
   is small enough to fit after A alone) — the pre-fix code returned
   only `[A]`, silently dropping `C` for no reason other than B's size.
   Confirmed the existing "context token budget" test suite had no
   scenario covering more than two blocks, so this gap had no coverage
   either. Fixed by changing `break` to `continue` (skip an oversized
   block, keep scanning for smaller ones that fit — the same greedy
   best-fit-by-score approach, just not stopping at the first miss),
   verified against the same probe (now returns `[A, C]`), and added a
   permanent regression test reproducing that exact three-block scenario
   to `retrieval.service.spec.ts`.

2. **`ChatService.persistError` never called `this.repository.touch()`.**
   Both other terminal paths of a turn — `streamAnswer`'s success case
   and `finishNoContext` — call `touch()` to bump the conversation's
   `updated_at` after finishing. `persistError` (used both when
   retrieval throws and when the model stream fails mid-generation) did
   not, so a conversation that ended in an error message never advanced
   its `updated_at` and wouldn't sort correctly in a "most recently
   active" conversation list, even though real activity (a user message,
   an error message) had just been written to it. Fixed by threading
   `conversationId` into `persistError` and calling `touch()` there too,
   matching the other two paths exactly. Added assertions to both
   existing error-path tests in `chat.service.spec.ts` (`retrieval
   throws` and `mid-stream failure`) confirming `repository.touch` is
   now called with the conversation id.

Checked and ruled out as non-issues: `RetrievalRepository`'s RLS
scoping (every query still goes through the caller's request-scoped
client; `match_document_chunks` is `security invoker` and filters on
`auth.uid()` directly, belt-and-suspenders with RLS on
`document_chunks` itself); the `chat` throttle bucket's wiring in
`app.module.ts` (correctly registered, reuses the same `UserThrottlerGuard`
mechanism already covered by Phase 3's tests, just under a different
named bucket — a dedicated 429-on-chat-bucket e2e test would be a nice-
to-have but isn't a gap in the guard itself); and the theoretical case
of a source document's own body containing literal `[S3]`-shaped text
being echoed back as a fake-looking citation — real in principle for any
RAG system that trusts document content, but out of scope for this pass
since it isn't specific to anything Phase 5 introduced.

Re-ran the full pipeline and e2e suite from the same fresh clone after
both fixes: `pnpm turbo run lint typecheck build test --force` clean
(54 unit tests, up from 53 — the two new/extended tests), `pnpm
test:e2e` still 26/26. Verdict: Phase 5 had two real, if minor, bugs;
both are now fixed, covered by regression tests, and verified.

### D5.10 — `mergeAdjacent` merged chunks from different sections; fixed a real bug surfaced by an externally-sourced claim

Given a specific, falsifiable claim to check — not asked to fix
anything, only to validate it — that `RetrievalService.mergeAdjacent`
merges two retrieved chunks whenever they're from the same document
with consecutive `chunk_index`, without ever checking `heading_path`,
even though D5.3's own justification for merging ("consecutive-index
chunks are the only case the chunker's overlap step can ever produce
shared text between") doesn't actually imply all consecutive-index
chunks should merge — the chunker explicitly never applies overlap
across a heading boundary, so two adjacent chunks from different
sections share no text at all.

Investigated read-only, from a fresh clone: read `mergeAdjacent`'s
actual merge condition (confirmed it checks only `chunkIndex`, never
`headingPath`), then read `chunker.ts` to confirm both of the claim's
premises about chunking behavior (headings never become chunk content;
overlap is skipped whenever `prev.headingPath !== curr.headingPath`).
Wrote a standalone probe using the real, unmodified `chunkDocument()`
fed straight into the real `RetrievalService` — not a synthetic
fixture — with a two-section document. It reproduced both claimed
symptoms exactly: the merged source reported `headingPath` as only the
first chunk's section, and its `content` contained the literal `"##
Section B"` heading line — text that was never part of either original
chunk's content. Traced both fields forward and confirmed they aren't
cosmetic: `headingPath` is what `prompt.ts` puts into the `<source
section="...">` attribute the model sees, and what `chat.service.ts`
surfaces to the user as the citation's location. Reported the claim as
accurate, with no changes made, per the "just validate this" framing —
the same discipline as D4.7's validate-first pass.

Asked next to fix it. Fixed by adding a `row.headingPath ===
current.headingPath` check alongside the existing `chunkIndex`
adjacency check in `mergeAdjacent` — two chunks now only merge when
they're both index-adjacent AND from the same section, which is the
actual condition under which the chunker can have left shared text
between them. Verified against the same probe (now returns two
separate sources, each with its own correct `headingPath` and no
leaked heading markup) and proved the regression tests aren't vacuous
by running them against the pre-fix code first (both failed, exactly
reproducing the reported symptom) before confirming they pass against
the fix. Added two permanent tests to `retrieval.service.spec.ts`: a
synthetic-fixture version matching the file's existing style, and an
end-to-end version that runs the real `chunkDocument()` output through
`RetrievalService`, reproducing the exact scenario rather than only a
hand-crafted one. Re-ran the full pipeline and e2e suite from the same
clone: clean throughout, 56/56 unit tests (up from 54), 26/26 e2e —
nothing else regressed.

### D5.11 — Third re-validation pass, mid-Phase-6: still clean

Asked again, from inside Phase 6, whether Phase 5 was "really done,
without gaps or bugs" — the fourth time this question has been put to
Phase 5 specifically (D1.5-style initial pass folded into D5.9's first
half, then D5.9/D5.10's two real bugs, now this). Dispatched to an
independent subagent with no memory of D5.9/D5.10's fixes, instructed
to read `RetrievalService`, `ChatService`, `prompt.ts`, and their specs
adversarially and report anything it found, then cross-checked its
report personally against the actual source rather than trusting the
summary. Confirmed: both D5.9 fixes (`continue` not `break` in
`packContext`; `persistError` calling `touch()`) and D5.10's fix
(`headingPath` equality in `mergeAdjacent`) are all still in place and
covered by their regression tests; no new issues surfaced. Full
pipeline clean (43/43 `@kb/rag-core`, 56/56 `apps/api` at the time).
Verdict: Phase 5 remains genuinely done — this pass didn't repeat
D5.9/D5.10's value because there was nothing left to find, which is
itself the useful confirmation.

## Phase 6

### D6.1 — Web app architecture: TanStack Query owns server state, a hand-rolled Sheet nav over shadcn's Sidebar, `use()` over `useSearchParams()` where possible

Three small, related choices that show up as doc comments throughout
`apps/web/src`, worth recording once instead of re-justifying at each
call site.

Server state (documents, conversations, usage) lives entirely in
TanStack Query — no separate client-side store duplicating it, no
prop-drilled cache. Lists that can still be indexing poll (`useDocuments`,
`useDocument`) only while at least one loaded row is `pending`/`indexing`,
stopping once everything's terminal, rather than polling unconditionally
or requiring a manual refresh — the same "live enough without
Realtime" tradeoff the brief calls out as acceptable.

The `(app)` route group's shell (`layout.tsx`) is a small hand-rolled
sidebar that collapses into a Radix `Sheet` on mobile, not shadcn's
full `Sidebar` primitive — that component's collapsible-rail and
cookie-persisted open/closed state is built for apps with far more nav
sections than this one's fixed three (Documents/Chat/Usage), and would
have added machinery with nothing to actually use it for.

Client Component pages that receive `params`/`searchParams` as props
(`/documents/[id]`, `/chat`) read them with React's `use()` on the
promises Next passes, per Next's own documented pattern for Client
Component pages — not the `useSearchParams()` hook, which needs a
Suspense boundary wrapper to avoid de-opting the whole page into
client-only rendering. The one exception is `/login`, which already
needs `useSearchParams()` for its `redirectTo` param and takes the
Suspense-wrapper cost there since `use()` isn't an option for a page
that's `"use client"` all the way up with no Server Component parent
handing it the promise.

One documented, intentional gap in the document editor
(`document-form.tsx`): a dirty draft is protected from being lost via a
native `beforeunload` handler (warns on tab close, refresh, or a typed
URL navigation) but not via any in-app navigation guard — Next.js's App
Router has no stable client-side navigation-blocking API as of this
phase, so clicking an in-app `<Link>` away from a dirty editor isn't
intercepted. Noted rather than silently accepted, so a future App
Router release that adds one has a clear place to wire it in.

### D6.2 — Next 16's dev server hangs forever mid-hydration in this sandbox (`experimental.reactDebugChannel`)

Asked to validate Phase 5 with real UI screenshots (not the DOM/HTML
captures earlier phases had relied on), every screenshot came back
looking right — until the first attempt to actually click something
(a dropdown, a tag filter) did nothing. The rendered HTML was correct
and complete; the page was simply inert, with no console error and no
network activity to explain it.

Traced it by reading the compiled client bundle, then the unminified
`next/dist/client/app-index.js`: Next 16's dev server defaults
`experimental.reactDebugChannel` to `true`, and client hydration
`await`s a WebSocket-based "debug channel" as part of resolving the
initial RSC payload, before `hydrateRoot()` is ever called. That
WebSocket handshake never completes in this sandbox specifically —
confirmed with a standalone probe: a bare `new WebSocket(...)` to the
dev server's own `/_next/hmr` endpoint fails from a Chromium/Playwright
context while the identical handshake succeeds via `curl`, and a
trivial unrelated `ws` server works fine from the same browser — so
it's this sandbox's proxying of Next's specific dev-server WebSocket
implementation, not a general WebSocket, CORS, or IndexedDB problem.
With hydration permanently blocked on a channel that will never open,
the app stays server-rendered HTML forever: correct-looking, completely
non-interactive, silent about why.

Fixed with `experimental: { reactDebugChannel: false }` in
`next.config.ts`, removing hydration's dependency on that channel
entirely. Verified fixed by checking for React fiber props on hydrated
DOM nodes and confirming dropdown menus actually open on click, then
captured all 19 requested UI screenshots against the now-genuinely-
interactive app. Worth carrying forward: this is a real, reportable
Next 16 dev-server behavior that could bite any sandboxed, proxied, or
CI environment where a WebSocket to the dev server's own origin doesn't
round-trip cleanly, not something specific to this repo.

### D6.3 — Usage page: one RPC, `security invoker`, grouped by (day, operation, model)

Built to the brief's own shape: a `usage_summary(p_from timestamptz)`
Postgres RPC (`security invoker`, filtering by `auth.uid()` like every
other query in this codebase, added in the Phase 1 migration file)
returns `ai_usage_events` grouped by day/operation/model with
prompt/completion/total token sums and an event count. `UsageService`
just calls it and sums the rows into overall totals — no new
aggregation logic duplicated between the DB and the app layer. The
frontend (`UsageView`) is a day-range selector (7/30/90) over four
stat tiles plus a "by model" breakdown table, built the same way as
every other feature in this phase: a TanStack Query hook
(`useUsage`) wrapping `apiFetch`, no separate store.

### D6.4 — `scripts/seed.mjs`: plain REST calls to Auth, not the Supabase JS SDK

Rewritten from its Phase 0 placeholder to actually create a demo user
(`demo@example.com`) and three sample documents through the real API,
so they go through the real indexing pipeline rather than being
inserted directly. Talks to Supabase Auth's REST endpoints
(`/auth/v1/signup`, `/auth/v1/token?grant_type=password`) with plain
`fetch`, not the Supabase JS SDK — this is a one-shot Node script, not
a long-lived client with a session to manage, and the SDK's main value
(token refresh, storage) doesn't apply here. Idempotent: a second run
signs the existing demo user back in instead of failing on "already
registered," and re-creates the three sample documents (POST
`/documents` has no title-uniqueness constraint, so this is
intentionally harmless to repeat, not something worth guarding
against). Loads the repo's root `.env` with Node 22's built-in
`process.loadEnvFile`, avoiding a `dotenv` dependency that isn't
hoisted to the repo root.

### D6.5 — Gate 6: a real browser, a real backend, no mocks — and the real bug that only that combination could catch

Built the same way Gate 3's e2e harness works (D3.1) — no Docker, a
real Postgres reachable as superuser, `bootstrap.sql`'s auth shim plus
the unmodified `supabase/migrations/*.sql`, a real PostgREST binary —
but extended with one new piece Gate 3 never needed:
`apps/web/e2e/support/auth-gateway.ts`, a small GoTrue-compatible shim
in front of PostgREST. Gate 3's e2e suite only ever needed a
hand-minted JWT, because `AuthGuard` has a local-HS256 verification
fallback; Gate 6 drives a real browser through `apps/web`, and
`@supabase/ssr`'s browser client calls `supabase.auth.getUser()` in
the app's own layout and proxy — which, per Supabase's documented
behavior, always makes a live round trip to `${SUPABASE_URL}/auth/v1/user`
to revalidate server-side, unlike the local/cookie-only `getSession()`.
Without something answering that endpoint the whole app hangs waiting
on it forever, so `auth-gateway.ts` answers signup/password-grant/
logout/get-user with real sessions signed with the same well-known
local secret PostgREST and `AuthGuard`'s fallback both already use,
and proxies `/rest/v1/*` straight through to real PostgREST.

One ordering subtlety worth recording: Playwright starts `webServer`
entries *before* running `globalSetup`, not after — confirmed by
reading the test runner's own task list rather than assuming. That
means every value a `webServer` needs (ports, the JWT secret, the
gateway URL apps/api and apps/web should point `SUPABASE_URL` at) has
to be a fixed constant available at config-load time, not something
`globalSetup` computes — hence `e2e/support/constants.ts` as the one
shared source of fixed ports/secrets both `playwright.config.ts` and
`global-setup.ts` import, rather than dynamic port allocation. Since
neither apps/api nor apps/web touches Supabase at process boot (only
per-request), the two servers coming up before the database/PostgREST/
gateway stack finishes setting up is harmless — nothing is called until
a test actually runs, by which point both tasks have completed.

Writing the actual smoke test (signup → load sample documents → wait
for indexing → open, edit, and save a document → ask a question in
chat → check the usage page → sign out/in → delete the document →
check mobile nav) surfaced a real, previously-undetected bug on the
very first run: saving an *existing* document silently did nothing.
The click registered, `handleSave` ran, but `save.mutateAsync` threw
`TypeError: Cannot read properties of undefined (reading 'map')` before
any network request was even sent — caught only by adding a temporary
`console.log` at the top of `handleSave`, since the failure was
swallowed into a `toast.error` that had already auto-dismissed by the
time the test's own timeout fired. Root cause: `useSaveDocument`'s
optimistic-update `onMutate` calls `queryClient.setQueriesData({
queryKey: documentsKeys.all }, ...)` with an updater that assumes
`InfiniteData<DocumentListResponse>` shape (`data.pages.map(...)`) —
but `documentsKeys.all` (`["documents"]`) is a prefix of *both* the list
queries' key and `documentsKeys.detail(id)`'s key, so React Query's
partial-key matching applies that same updater to the plain
`DocumentDetail` object cached for the currently-open document too.
That object has no `.pages`, so the updater throws — before the
`mutationFn` (the actual PATCH) ever runs. This bug existed for every
edit-and-save of an already-existing document; it was never caught by
unit tests (which construct isolated fake query clients, never one
with both a list and a matching detail entry populated together) or by
earlier manual screenshot passes (which exercised *creating* documents,
whose `id`-less mutation path skips this block of `onMutate` entirely).
Only a real browser driving a real, live TanStack Query cache through
the actual edit-an-existing-document flow could have surfaced it.

Fixed by giving list queries their own dedicated partial key,
`documentsKeys.lists = ["documents", "list"]`, distinct from `.detail`,
and scoping both the optimistic updater and its `previousLists`
snapshot to `.lists` instead of the too-broad `.all`. Verified by
re-running the smoke test (now green, save round-trips for real) and
the full pipeline (`lint typecheck build test --force`, 19/19 tasks,
including apps/api's own 61/61 unit tests, confirming nothing else
depended on the old, accidentally-broad matching). Also worked around
two sandbox-specific, non-app issues hit while building this harness:
apps/web's tsconfig pulls in the DOM `lib`, so `fetch`'s `Response.body`
resolves to a DOM `ReadableStream` type incompatible with
`node:stream/promises`'s `pipeline` — bridged with `Readable.fromWeb`
plus an explicit cast, since the two lib.d.ts's `ReadableStream`
declarations aren't structurally identical even though the runtime
object is the same undici stream either way; and Next's dev server
refuses to start a second instance against the same project directory
even on a different port (its lock lives in `.next/`, keyed by
directory) — resolved with a `NEXT_DIST_DIR` env var routing Gate 6's
own `next dev` to a separate `.next-e2e` build directory, leaving a
person's own `:3000` dev server (and its lock) untouched.

### D6.6 — A brand-new conversation's first answer never streamed: `router.replace` unmounted the live stream mid-turn

Asked to validate Phase 6 was really done, dispatched an independent
subagent with no memory of this codebase's history to read the Phase-6
frontend adversarially, cross-checked its one finding personally before
accepting it (same discipline as every other bug reported in this
project). The claim: `/chat` and `/chat/[conversationId]` are two
separate `page.tsx` files, not one component parameterized by a route
param, so a real Next.js navigation between them unmounts and remounts
whatever's rendered — and `chat-view.tsx`'s `handleStarted` called
`router.replace('/chat/' + newConversationId)` the moment the SSE
`start` event reported the server-assigned id, which is the *first*
event of every turn, arriving well before any `delta`. That navigation
unmounted the in-flight `useChatStream` instance mid-turn: the
`send()` async generator kept running (it's a plain closure, not tied
to React's lifecycle) and kept calling `dispatch()`, but into a
`useReducer` whose owning component no longer existed, so every
subsequent `delta`/`citation`/`done` — and any `error` — was silently
dropped. The freshly-mounted `/chat/[conversationId]` page created its
own brand-new `useChatStream` that never called `send()`, so the user
saw nothing (not even a "Searching…" indicator) until the turn finished
server-side and a background query invalidation pulled the completed
answer back in as one static block.

Verified directly rather than trusting the report: read
`chat-view.tsx`/`use-chat-stream.ts`, confirmed no shared `layout.tsx`
exists between the two chat routes, then wrote a diagnostic Playwright
script polling the message area's text and the URL every 300ms (later
50ms) through a real new-conversation send. It reproduced exactly what
was claimed: the URL flips to `/chat/[id]` a moment after send, and the
message area's content genuinely drops (to the composer's empty state,
in one run; to a shorter string, in another) right at that instant,
before the full answer reappears ~300ms later via the refetch — not a
permanent loss of the final answer, but a real, visible break in the
"streams live" experience the brief specifies, and a completely silent
failure mode for the rarer but real case of a stream erroring mid-turn.

Fixed by no longer letting URL adoption be a real navigation: `chat-
view.tsx` now tracks the adopted `conversationId` as local component
state (seeded from the route param, updated by `handleStarted`) and
updates the address bar with `window.history.replaceState` instead of
`router.replace` — same visible URL, same browser-history semantics
(replace, not push), but no App Router navigation and therefore no
remount, since React preserves a component's hook state across
re-renders of the same mounted instance regardless of what argument
values change. `useConversation` and `ConversationList`'s `activeId`
now read that same local state rather than the (now effectively
static) route prop, so conversation history correctly starts loading
the moment the id is adopted rather than never. Re-ran the same
diagnostic script against the fix: the URL updates with no content
drop at any sampled instant. Added a permanent regression test to
`smoke.spec.ts` that samples the message area through the exact
adoption window and fails if it ever reverts to the idle empty state
after showing the turn — proved non-vacuous by running it against the
pre-fix code first (failed, reproducing the exact symptom) before
confirming it passes against the fix. Full pipeline and a from-scratch
fresh clone's Gate 6 run both clean afterward.

### D6.7 — Gate 6's smoke test flaked on a genuinely cold run: too tight a per-test timeout, not an app bug

Re-running Gate 6 from a truly fresh clone (no `.next-e2e` build cache,
simulating what every real CI run looks like — CI's `reuseExistingServer:
false` means every run starts this cold, not just the first one ever)
reproducibly hit Playwright's default per-test timeout at whatever step
happened to be running when the budget ran out — not the same step
twice in a row, which was itself the tell that this wasn't a logic bug
in one place. Root cause: the one smoke test walks roughly seven
distinct routes, and Next's dev server compiles each on first request;
against a genuinely cold `.next-e2e` that compile overhead alone
(confirmed by timing repeated fully-cold runs, consistently 30-36s
total) left no margin under the original 30-second test timeout,
which real per-request latency (Postgres, real embedding/chat calls
through the mock provider, SSE streaming) then reliably pushed over.

Fixed by raising the test timeout to 90 seconds — generous enough to
absorb a cold compile pass without masking an actual hang, since a
truly broken flow still fails within that budget rather than needing
the full 90s to prove it's broken. Verified by deleting `.next-e2e` and
re-running from-scratch three times in a row: consistently green,
34-36s each, comfortably under the new budget.

### D6.8 — Local `pnpm dev` intermittently failed with "no exported member" from @kb/shared: dev task had no build ordering

Reported from a real local dev run (not Gate 6, which always builds
from a fresh checkout in dependency order): `apps/api`'s NestJS watch
compiler failed with `TS2305: Module '"@kb/shared"' has no exported
member 'ChatRequestSchema'` (and ~30 similar errors) immediately after
a fresh `pnpm install`. `packages/shared/dist` was confirmed to
already contain every one of the "missing" exports by the time this
was investigated — so the built output was correct, but stale relative
to what the running dev process had loaded.

Root cause: `turbo.json`'s `dev` task had no `dependsOn`, so `turbo dev`
started `@kb/shared`'s `tsup --watch`, `apps/api`'s `nest start --watch`,
and `apps/web`'s `next dev` all concurrently. On a fresh install (empty
or missing `packages/shared/dist`), `apps/api`'s watch compiler can load
its very first program before `tsup`'s initial build finishes writing
`dist/index.d.ts` — and because NestJS's watch compiler doesn't re-check
node_modules on later file changes, it keeps reporting the exports it
saw at that first, incomplete snapshot even after `tsup` finishes.
Every other task that touches workspace packages (`build`, `lint`,
`typecheck`, `test`) already had `dependsOn: ["^build"]`; `dev` was the
one task that didn't, since making a *persistent* task depend on a
one-shot `build` task is unusual — but here it's exactly what's needed:
it forces `@kb/shared#build` to run once and complete before any
dependent app's `dev` task starts, after which `@kb/shared`'s own `dev`
(`tsup --watch`) takes over for incremental rebuilds.

Fixed by adding `"dependsOn": ["^build"]` to the `dev` task in
`turbo.json`. This only affects task *ordering* on startup (build the
dependency once, then start every `dev` script, including the
dependency's own watcher, together) — it does not disable hot-reload
for `packages/shared`, since `tsup --watch` still runs as part of `dev`
once that initial build has completed. Not caught by Gate 6 because its
`webServer` entries only ever start against a checkout where `pnpm
install` (and thus every workspace package's build, via other commands
run beforehand in that harness) had already completed — this race is
specific to `turbo dev` being the very first command run after a fresh
`node_modules`.

### D6.9 — `supabase start` rejected the local config: `major_version = 16` isn't a version Supabase ships

The first real `supabase start` run against this repo's `supabase/config.toml`
(on a reviewer's actual machine, with Docker — the cloud sandbox this
project was otherwise built in has no Docker, so this path was never
exercised end to end until now; see this file's own header comment) failed
immediately: `Failed reading config: Invalid db.major_version: 16.`

Root cause: `[db] major_version` was set to `16`, but Supabase never
shipped a Postgres 16 image — its local/hosted Postgres line went
straight from 15 (LTS) to 17, skipping 16 entirely, and the CLI validates
`major_version` against the versions it actually has images for. `16`
was never a valid value here; it just happened to never get checked
before because nothing had run `supabase start` against this file yet.

Fixed by setting `major_version = 15` — the CLI's own documented
default and the version this project's migrations/RLS work (Phase 1)
and Gate 3's Postgres-substitute e2e harness were actually developed
and validated against.

### D6.10 — Workspace packages' `tsup --watch` cleaned `dist` on every rebuild, racing `apps/api`'s watch compiler

D6.8 fixed the *first* startup race (apps/api's watch compiler loading
`@kb/shared` before its very first build finished) by making `turbo
dev`'s `dev` task depend on `^build`. Re-running `pnpm dev` after that
fix still hit the same class of error — this time against `@kb/ai`:
`TS7016: Could not find a declaration file for module '@kb/ai'`, with
`packages/ai/dist/index.d.ts` confirmed present and correct moments
later.

Root cause: every workspace package's `tsup.config.ts` had `clean:
true` unconditionally, including under `tsup --watch`. tsup honors
`clean` on *every* rebuild it runs in watch mode, not just the first —
so each package's own persistent `dev` script (`tsup --watch`, started
by `turbo dev` alongside `apps/api`'s and `apps/web`'s dev servers)
deletes and regenerates its `dist/` on every rebuild, including its
initial one. D6.8's `dependsOn: ["^build"]` only orders the one-shot
`build` task before dependents start `dev` — it has no way to also
order a dependency's own long-running `dev` (watch) task, so nothing
stops `@kb/ai#dev`'s first `tsup --watch` cycle from clearing
`packages/ai/dist` at (or after) the same moment `apps/api#dev` starts
compiling against it. Whichever package's watcher happened to be
slowest to finish that first cycle looked "broken"; it varied by run
(D6.8 saw it hit `@kb/shared`, this run hit `@kb/ai`) because it's pure
scheduling timing, not a per-package bug.

Fixed by making `clean` conditional on tsup's own `options.watch` flag
(`clean: !options.watch`) in all three workspace packages'
`tsup.config.ts` (`shared`, `rag-core`, `ai`) — a one-shot `build` still
wipes `dist` first (as it should, to catch stale/renamed output files),
but `--watch` mode never deletes `dist` mid-session, so a consumer
compiling at any point during `turbo dev` — at startup or after a later
source edit — always sees a complete, valid package rather than a
directory that's momentarily empty or mid-rewrite.
