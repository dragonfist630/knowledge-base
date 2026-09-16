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

More entries land as Phase 1+ makes their own calls (RLS pattern, chunking
numbers, hybrid retrieval, etc.).
