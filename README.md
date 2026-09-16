# Knowledge Base

AI-Powered Knowledge Base — a Goodspeed Studio technical assessment build.

> **Status: Phase 0 (scaffolding) only.** This README covers what exists
> right now. The full README — architecture diagram, key decisions, the
> provider-swap guide, API reference, scaling notes, and the Loom links —
> lands in Phase 9, once there's a real app to document.

## Quick start

Prerequisites: Node 22 (see `.nvmrc`), pnpm, Docker (for local Supabase —
lands in Phase 1).

```bash
git clone <repo-url> knowledge-base
cd knowledge-base
pnpm setup
pnpm dev
```

- `pnpm setup` checks prerequisites, installs dependencies, copies
  `.env.example` to `.env` (without touching one you already have), and
  builds `packages/*`. Local Supabase, migrations, and seeding activate
  once Phase 1–4 land; today it prints what it skipped and why.
- `pnpm dev` runs `apps/web` on <http://localhost:3000> and `apps/api` on
  <http://localhost:3001> (`GET /health` → `{"status":"ok"}`).

## What's here

```
apps/
  web/                Next.js 16 (App Router)
  api/                NestJS 12 — GET /health only so far
packages/
  shared/             zod schemas + types shared by web and api (empty shell for now)
  ai/                 the provider-agnostic AI layer (Phase 2)
  rag-core/           pure chunking/prompt/citation functions (Phase 4/5)
  eslint-config/       shared flat ESLint config
  tsconfig/            shared tsconfig bases
scripts/setup.mjs      the one-command setup
docs/DECISIONS.md      ADR-style log of choices and why
```

## Other commands

```bash
pnpm lint        # turbo lint across every package
pnpm typecheck   # turbo typecheck across every package
pnpm build       # turbo build across every package
pnpm test        # turbo test across every package (real specs start Phase 3)
```

`pnpm db:*`, `pnpm seed`, `pnpm eval`, and `pnpm ai:check` are wired up in
`package.json` already; they become useful as the phases that back them
(1, 2, 3/4, 8) land.
