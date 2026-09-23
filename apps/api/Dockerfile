# syntax=docker/dockerfile:1
#
# Production image for apps/api (NestJS). Build from the REPO ROOT, not
# this directory, so the pruner stage's `COPY . .` sees the whole pnpm
# workspace (turbo prune needs the full monorepo to compute the pruned
# subset — see docs/DECISIONS.md D9.13):
#
#   docker build -f apps/api/Dockerfile -t kb-api .
#   docker run -p 3001:3001 --env-file .env kb-api
#
# Required env at runtime (validated at boot by src/config/env.ts — a
# missing/invalid one fails fast with a readable error, not a silent
# crash): SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY. See .env.example and
# docs/DEPLOYMENT.md for the full surface (AI_*, RAG_*, THROTTLE_*, all
# defaulted) and for why this app must run as exactly one instance
# (IndexingQueue is in-process, in-memory — see docs/ARCHITECTURE.md and
# docs/SCALING.md item 7).
#
# `turbo prune api --docker` (Vercel's own documented pattern for a
# Turborepo + pnpm monorepo — see https://turborepo.com/docs/guides/tools/docker)
# produces exactly the subset of the workspace apps/api actually depends
# on (here: @kb/ai, @kb/rag-core, @kb/shared, plus the dev-only
# @kb/eslint-config/@kb/tsconfig turbo's graph always includes — verified
# by actually running it against this repo, not assumed from the docs
# alone), split into `out/json/` (just the package.json files, for a
# cacheable install layer) and `out/full/` (the real pruned source).

FROM node:22-alpine AS base
# Enables corepack's shipped pnpm; pinned to the version this repo's
# package.json#packageManager declares, so the lockfile this build reads
# (out/full/pnpm-lock.yaml, copied from the *real* repo lockfile by `turbo
# prune`) is always read by the exact pnpm version it was produced with.
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
# glibc compatibility shim a few native-addon npm packages need even
# though nothing in *this* repo currently pulls one in directly — cheap
# insurance against a future transitive dependency needing it, standard
# in Alpine Node images for this reason.
RUN apk add --no-cache libc6-compat

FROM base AS pruner
WORKDIR /app
COPY . .
RUN npx turbo prune api --docker

FROM base AS installer
WORKDIR /app
# json/ first, alone: this layer only invalidates when a package.json or
# the lockfile changes, not on every source edit, so `pnpm install` stays
# cached across ordinary code-only rebuilds.
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
# Now the real pruned source, and build — turbo.json's build task
# (`dependsOn: ["^build"]`) builds @kb/shared/@kb/ai/@kb/rag-core before
# api, same dependency order `pnpm --filter @kb/shared build` etc. is run
# in manually elsewhere in this project.
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo run build --filter=api

FROM base AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 apiuser && adduser --system --uid 1001 --ingroup apiuser apiuser
# Everything the installer stage produced: built dist/ for every workspace
# package plus a full (dev+prod) node_modules. Not the leanest possible
# image (a --prod-only install would need `pnpm deploy`'s workspace
# resolution, deliberately not taken on here — see docs/DECISIONS.md
# D9.13 for why that was left as a documented future optimization rather
# than adding untested complexity in the same change as everything else
# here), but correct and reproducible: this is the actual same
# node_modules the build ran and was verified against.
COPY --from=installer --chown=apiuser:apiuser /app .
USER apiuser

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

# /health is @Public() (no auth required) and touches nothing but process
# memory — see src/meta/health.controller.ts — so this never false-fails
# on a transient Supabase/AI-provider blip the app itself would already be
# retrying around.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/main.js"]
