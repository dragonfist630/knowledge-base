# Deployment

What exists today (D9.13, Phase 9): a production Docker image for each
app, and a CI workflow that builds and tests everything on every push. What
doesn't exist: anywhere those images actually run. This document is the
"how to build and run the images" reference `docs/ARCHITECTURE.md`'s
"Deployment shape as it exists today" section points to; it isn't a claim
that this app is deployed anywhere, or a specific platform's setup guide.

## The two images

`apps/api/Dockerfile` and `apps/web/Dockerfile` are independent — build,
run, and (if this were ever load-balanced) scale them separately. Both use
`turbo prune --filter <app> --docker` (Vercel's documented pattern for a
Turborepo + pnpm monorepo) to build from a pruned subset of the workspace
containing only what that app actually depends on, not the whole repo.

Build from the **repo root** (not `apps/api/` or `apps/web/`) so each
Dockerfile's pruner stage can see the whole workspace:

```bash
docker build -f apps/api/Dockerfile -t kb-api .

docker build -f apps/web/Dockerfile -t kb-web \
  --build-arg NEXT_PUBLIC_API_URL=https://api.example.com \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://xyz.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_... \
  --build-arg NEXT_PUBLIC_SITE_URL=https://app.example.com
```

apps/web's `NEXT_PUBLIC_*` values **must** be supplied as build args, not
just at `docker run` time — Next.js inlines them into the client JS bundle
during `next build`, so a value only set when the container starts is
invisible to code the browser already downloaded. See
`apps/web/Dockerfile`'s own top-of-file comment for the mechanism
(`scripts/with-root-env.mjs` forwarding already-set env straight through,
verified against `root-env.mjs`'s actual precedence rules, not assumed).

## Running them

```bash
docker run -p 3001:3001 --env-file .env kb-api
docker run -p 3000:3000 \
  -e NEXT_PUBLIC_SUPABASE_URL=https://xyz.supabase.co \
  -e NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_... \
  kb-web
```

Both images expose a `HEALTHCHECK`: apps/api's hits its real `/health`
endpoint (no auth required, touches nothing but process memory — see
`apps/api/src/meta/health.controller.ts`); apps/web's hits `/login` and
only checks the Node process is alive and answering, not that the whole
app stack (Supabase, the AI provider) is actually reachable — that's
apps/api's job, not a static page's.

## Required environment

Same contract as running the apps directly with `node` (see the root
`.env.example`, which remains the source of truth this list is kept in
sync with) — Docker changes nothing about what each app reads, only how
its process gets started. apps/api's `SUPABASE_URL` and
`SUPABASE_PUBLISHABLE_KEY` are the only two genuinely required values
(validated at boot by `apps/api/src/config/env.ts` — a missing or invalid
one fails fast with a readable error, not a silent crash or a confusing
runtime failure three requests later); everything else (`AI_*`, `RAG_*`,
`THROTTLE_*`, `WEB_ORIGIN`) has a working default, and `AI_CHAT_PROVIDER`/
`AI_EMBEDDING_PROVIDER` default to `mock`, so the API runs with zero AI
provider keys configured (see `docs/PROVIDERS.md` to point it at a real
one). A real deployment should still set `SUPABASE_JWT_SECRET` to nothing
(leave it unset) unless pointed at a self-hosted Supabase instance — a
hosted Supabase project's `AuthGuard` verification never touches it (see
`docs/DECISIONS.md` D3.1); setting it against a hosted project's real
JWTs would be a no-op at best.

For apps/web, `NEXT_PUBLIC_API_URL` and the `NEXT_PUBLIC_SUPABASE_*` pair
are the ones that matter and must be set at build time (above); the rest
of the monorepo's root `.env` (apps/api's own config, `THROTTLE_*`,
`AI_*`) is irrelevant to this image, same as it always was for `next
build`/`next start` — see `apps/web/scripts/root-env.mjs`'s own doc
comment for why that separation is enforced by code, not just convention.

Neither image bakes in a `.env` file — both read real environment
variables from whatever starts the container (`docker run -e`/
`--env-file`, or a platform's own secrets/env mechanism). That's
deliberate: an image with secrets baked in can't be safely pushed to a
registry or shared between environments.

## Constraints that don't go away just because there's now an image

**Running more than one `apps/api` instance is no longer an indexing
-correctness hazard (D9.14), but nothing here actually runs more than
one.** `IndexingQueue` used to be in-process and in-memory — two
containers running against the same database would each silently believe
they alone owned the world, duplicating embedding work and dropping
queued jobs on restart. That's fixed: indexing state now lives in the
durable, RLS-scoped `document_indexing_jobs` table, and jobs are claimed
atomically (`claim_indexing_jobs`, `for update skip locked`) — two
replicas racing to claim the same job can no longer both succeed. See
`docs/ARCHITECTURE.md` and `docs/DECISIONS.md` D9.14 for the full design
and how it was verified, including under real concurrent transactions.
What's still true: there's no background worker independent of a live
request (claiming only happens request-adjacent — right after a save, or
via `resumeStuckIndexing` on a later read), and no orchestrator config
anywhere in this repo that would actually run `apps/api` at
`replicas: 2+` — see `docs/SCALING.md` item 1 for both of those in full.

**Postgres isn't part of either image.** Both expect a reachable, already
-migrated Supabase project (hosted, or self-hosted separately) — see the
root README's "Hosted Supabase" section for what that setup looks like.
Nothing here packages, deploys, or manages Postgres itself.

## CI

`.github/workflows/ci.yml` runs on every push/PR to `main`:
typecheck+lint+unit-tests (no external services needed — see `checks`),
Gate 3 (`apps/api`'s e2e suite against a real Postgres service container
and a real, auto-downloaded PostgREST binary — the same Docker-free
harness described in `docs/DECISIONS.md` D3.1, just running inside a CI
job instead of on a laptop), Gate 6 (`apps/web`'s Playwright suite against
a real Chromium), and a build of both Docker images (`docker-build` — the
one job that could NOT be verified the same way as everything else in this
project before landing, since the sandbox this was built in has no route
to Docker Hub; see `docs/DECISIONS.md` D9.13 for exactly what was verified
locally instead, and why this job exists specifically to close that gap
going forward).
