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
