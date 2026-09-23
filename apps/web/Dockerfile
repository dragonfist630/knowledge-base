# syntax=docker/dockerfile:1
#
# Production image for apps/web (Next.js standalone output). Build from
# the REPO ROOT, same reason as apps/api/Dockerfile:
#
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.example.com \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=https://xyz.supabase.co \
#     --build-arg NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_... \
#     --build-arg NEXT_PUBLIC_SITE_URL=https://app.example.com \
#     -t kb-web .
#   docker run -p 3000:3000 \
#     -e NEXT_PUBLIC_SUPABASE_URL=https://xyz.supabase.co \
#     -e NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_... \
#     kb-web
#
# NEXT_PUBLIC_* must be supplied as BUILD ARGS, not just at `docker run`
# time: Next.js inlines them into the client JS bundle during `next
# build`, so a value only set at container-start is invisible to code
# already running in the browser. (They're passed again at `docker run`
# above too because a few call sites — src/lib/supabase/browser.ts among
# them — also read them from the server process at request time; supplying
# both is the only way to be right either way.) See docs/DEPLOYMENT.md and
# docs/DECISIONS.md D9.13.
#
# `turbo prune web --docker` — same pattern and same live-verified command
# as apps/api/Dockerfile — produces the pruned workspace subset apps/web
# depends on.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
RUN apk add --no-cache libc6-compat

FROM base AS pruner
WORKDIR /app
COPY . .
RUN npx turbo prune web --docker

FROM base AS installer
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .

# See the top-of-file note: these become real env vars for this RUN layer
# only, which is exactly when `next build` needs them (to inline into the
# client bundle) — apps/web/package.json's build script
# (scripts/with-root-env.mjs) forwards any NEXT_PUBLIC_* already present
# in the real environment straight through, no root .env file required
# (verified: root-env.mjs's resolveWebEnv treats already-set process.env
# as authoritative over anything a .env file would add).
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
RUN pnpm turbo run build --filter=web

FROM base AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 webuser && adduser --system --uid 1001 --ingroup webuser webuser

# Only the standalone server's own traced output — this is the whole
# point of `output: "standalone"` (next.config.ts): a self-contained
# server.js plus only the node_modules it actually touches, dramatically
# smaller than copying the installer stage's full node_modules the way
# apps/api/Dockerfile does (Next has no equivalent tracing step for a
# plain Node service, which is why that one takes the simpler,
# less-lean-but-correct path instead — see its own doc comment).
# Static assets and public/ are traced separately and must be copied in
# by hand — this is standard, documented Next.js standalone-output
# behavior, not something specific to this repo.
COPY --from=installer --chown=webuser:webuser /app/apps/web/.next/standalone ./
COPY --from=installer --chown=webuser:webuser /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=installer --chown=webuser:webuser /app/apps/web/public ./apps/web/public
USER webuser

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# The standalone server.js binds and starts serving even without a real
# Supabase/API backend reachable (verified locally); a page that actually
# needs one may still 500, which is what this reduced-scope check is
# deliberately NOT trying to catch — it's a liveness check for the Node
# process, not a full-stack health check apps/api's /health already is.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
