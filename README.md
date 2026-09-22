# Knowledge Base

AI-Powered Knowledge Base — a Goodspeed Studio technical assessment build.

> **Status: Phase 6 (post-launch audit & hardening).** The core app is
> built and working end to end: sign up/sign in, create and edit Markdown
> documents, ask questions about them in a streaming chat with inline
> citations, and track AI usage/cost. Phase 6 is a from-scratch review of
> the whole thing — security, retrieval correctness, chat/editor UX, and
> these docs — with every fix verified live (forged tokens, a real
> Postgres + pgvector instance, non-vacuous regression tests), not just
> read. See `docs/DECISIONS.md` for the full, dated log of every decision
> and fix, including this phase's. An architecture diagram, a full API
> reference, scaling notes, and the Loom walkthroughs are still Phase 9
> deliverables, not yet written.

## What's here

- **Documents** — Markdown documents with tags, live Markdown preview,
  citation deep-links (`/documents/:id?highlight=start-end` selects and
  scrolls to the cited range), and background indexing with a visible
  status (pending/indexing/ready/failed) and a one-click retry on failure.
- **Chat** — ask questions scoped to all documents, specific documents, or
  a tag filter. Answers stream token-by-token over SSE with numbered
  citations linking back to the exact source passage. Retrieval is hybrid
  (pgvector semantic search + Postgres full-text search, fused with
  reciprocal rank fusion) and only ever returns chunks that still match
  the document's current content — see `docs/DECISIONS.md` D6.15.
- **Auth** — email/password via Supabase Auth, enforced by Postgres RLS on
  every table (no service-role client anywhere in `apps/api`) and a
  redirect-safety check on the post-login `redirectTo` param (D6.14).
- **Usage** — a page showing token usage and estimated cost by day,
  operation, and model.

## Quick start

Prerequisites: Node 22 (see `.nvmrc`), pnpm (`corepack enable`), and either
Docker (for local Supabase) or a hosted Supabase project — see
[Hosted Supabase](#hosted-supabase-no-docker) below if you don't have
Docker.

```bash
git clone <repo-url> knowledge-base
cd knowledge-base
pnpm setup
pnpm dev
```

- `pnpm setup` checks prerequisites, installs dependencies, copies
  `.env.example` to `.env` (never overwriting a value you've already set),
  starts local Supabase and applies migrations, defaults to keyless
  **mock** AI providers if no API key is present, and builds `packages/*`
  and `apps/api` (needed for `pnpm ai:check`/`pnpm seed` to work right
  after setup — see `docs/DECISIONS.md` D6.17).
- `pnpm dev` runs `apps/web` on <http://localhost:3000> and `apps/api` on
  <http://localhost:3001> (`GET /health` → `{"status":"ok"}`).
- `pnpm setup` does **not** seed demo data — that needs `apps/api` actually
  running, which setup doesn't start on its own. Once `pnpm dev` is up, run
  `pnpm seed` in a second terminal to create the demo login
  (`demo@example.com` / `demo-password-123`) and a handful of sample
  documents.
- No AI API key needed to try it: `pnpm setup` defaults to
  `AI_CHAT_PROVIDER=mock`/`AI_EMBEDDING_PROVIDER=mock`, which makes the
  whole app usable (deterministic canned answers) with zero cost or
  external calls. Add a real key to `.env` and see
  [`docs/PROVIDERS.md`](docs/PROVIDERS.md) to switch providers — then run
  `pnpm ai:check` to verify the new config actually works (a real 1-token
  chat completion and 1-input embedding call) before wiring it into the
  rest of the app.

### Hosted Supabase (no Docker)

Local Supabase (via the Supabase CLI + Docker) is the default and the path
`pnpm setup` automates. If you don't have Docker, use a hosted Supabase
project instead:

1. Create a project at [supabase.com](https://supabase.com) and, in the
   SQL editor, run every file in `supabase/migrations/` in order (oldest
   filename first).
2. From the project's Settings → API page, set these in `.env` (copy
   `.env.example` to `.env` first if you haven't already):
   ```
   SUPABASE_URL=https://<project-ref>.supabase.co
   SUPABASE_PUBLISHABLE_KEY=<the anon/publishable key>
   NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<the anon/publishable key>
   SUPABASE_SERVICE_ROLE_KEY=<the service_role key>
   ```
   Leave `SUPABASE_JWT_SECRET` blank — it's only used by
   `apps/api`'s local-development HS256 fallback for a bare, Docker-less
   `supabase start`, which signs with a fixed, publicly-known secret. A
   hosted project signs with real asymmetric keys, so `AuthGuard` verifies
   through Supabase's `getClaims()`/JWKS instead and never reads this
   value in production (`NODE_ENV=production` also hard-disables that
   fallback outright regardless — see `docs/DECISIONS.md` D6.14).
3. Run `SKIP_DOCKER=1 pnpm setup` — it installs dependencies, writes
   `.env` from the example, and builds `packages/*`/`apps/api`, without
   attempting `supabase start`.
4. `pnpm dev`, then `pnpm seed` once it's up, same as the local path.

## What's here

```
apps/
  web/                Next.js 16 (App Router) — documents, chat, auth, usage
  api/                NestJS 12 — auth, documents, indexing, retrieval, chat, usage
packages/
  shared/             zod schemas, DTOs, and the generated Supabase Database type
  ai/                 provider-agnostic AI layer — ChatModel/EmbeddingModel + a mock
  rag-core/           pure chunking/prompt/citation functions, no I/O
  eslint-config/       shared flat ESLint config
  tsconfig/            shared tsconfig bases
supabase/
  migrations/          schema, RLS policies, and retrieval/indexing RPCs (SQL)
  tests/                pgTAP tests for the RPCs and RLS isolation (`pnpm db:test`)
scripts/setup.mjs      the one-command setup
scripts/seed.mjs       creates the demo login + sample documents (needs apps/api running)
scripts/eval-retrieval.mjs   retrieval-quality harness — NOT implemented yet, a
                             deliberate Phase 8 placeholder; running it just prints
                             that and exits (see `pnpm eval` below)
docs/DECISIONS.md      dated ADR-style log of every choice, bug, and fix and why
docs/PROVIDERS.md      the full AI provider swap guide (OpenAI, Groq, Together, …)
docs/AI_WORKFLOW.md    a running log of what was asked of the AI each phase
```

## Other commands

```bash
pnpm lint            # turbo lint across every package
pnpm typecheck       # turbo typecheck across every package
pnpm build           # turbo build across every package
pnpm test            # turbo test across every package (unit/pure-logic tests)
pnpm test:e2e        # Gate 6: a real browser against a real backend — see below
pnpm check:dev-boot  # boots `pnpm dev` for real and asserts it actually serves a page
pnpm db:start        # supabase start
pnpm db:stop         # supabase stop
pnpm db:reset        # reapply every migration to the local database
pnpm db:test         # pgTAP tests in supabase/tests/ (needs local Supabase up)
pnpm db:types        # regenerate packages/shared/src/database.types.ts from the local DB
pnpm seed            # demo login + sample documents (needs `pnpm dev` running first)
pnpm ai:check        # verify your AI_* config with one real chat + embedding call
pnpm eval            # NOT implemented — prints a placeholder message; see above
```

### Running the e2e suite (`pnpm test:e2e`)

Gate 6 drives a real Chromium browser against real `apps/web`/`apps/api`
instances and a real Postgres + pgvector database — no mocks, and no
Docker. It needs:

- A reachable Postgres superuser connection on `127.0.0.1:5432` (user
  `postgres`, password `postgres`, database `postgres`) — e.g. a plain
  `postgres` install, or override with `E2E_POSTGRES_SUPERUSER_URL`. This
  is separate from your local Supabase's own Postgres; the suite creates
  and drops its own ephemeral database (`kb_e2e_web` by default) on that
  connection each run.
- `pgvector` installed as an extension Postgres can load (`CREATE
  EXTENSION vector` must succeed on that connection).
- A PostgREST binary — auto-downloaded to `.cache/postgrest/` on first run
  if none is found on `PATH` or at `POSTGREST_BIN`.

`apps/api`'s own e2e suite (`apps/api/test/e2e`, run via `pnpm --filter
api test:e2e`) needs the same Postgres superuser connection and PostgREST
binary, at different fixed ports — see `apps/web/e2e/support/constants.ts`
and `apps/api/test/e2e` for the exact values, both overridable by
environment variable if the defaults collide with something already
running on your machine.

## Further reading

- [`docs/DECISIONS.md`](docs/DECISIONS.md) — the full, dated log of every
  architectural choice, bug found, and fix made, phase by phase. This is
  the most complete and most current source of truth in this repo.
- [`docs/PROVIDERS.md`](docs/PROVIDERS.md) — the AI provider swap guide.
- [`docs/AI_WORKFLOW.md`](docs/AI_WORKFLOW.md) — a narrative log of what
  was asked of the AI each phase and how mistakes got caught.
