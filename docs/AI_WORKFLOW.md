# AI Workflow

A running log of what got asked of the AI each phase, what it got wrong,
and how that got caught and corrected — kept for the second Loom (see
docs/DECISIONS.md for the full technical rationale behind each decision
mentioned here; this file is the short, narrative version).

## Phase 0 — scaffolding

Asked for the Turborepo/pnpm workspace skeleton, NestJS 12 API, Next.js
web app, and shared tsconfig/eslint packages, following the brief's
directory layout. It defaulted to NestJS 11 (the brief's stated version)
until told to check current npm versions — 12 was current and there was
no reason to pin an old major deliberately, so the repo deviates from the
brief on purpose (D0.1). It also generated an e2e spec importing a
`supertest/types` subpath that doesn't exist for the installed
`supertest`/`@types/supertest` version pair — caught by actually running
`pnpm typecheck`, not by review.

## Phase 1 — schema, RLS, retrieval SQL

Asked for the Postgres schema (documents, chunks, pgvector), RLS
policies, and the `match_document_chunks`/`replace_document_chunks`
functions. First-pass SQL cast embeddings as `vector` inside a recordset
function where Postgres actually needs `text` (D1.1); missed that the
HNSW index on `document_chunks` wasn't actually being used by the match
function's query shape until a second, skeptical re-validation pass
deliberately went looking for gaps the literal Gate 1 checklist didn't
cover (D1.5) — a real bug an AI-written test suite alone hadn't caught,
because the suite tested correctness, not the query plan. Verified with
`EXPLAIN` before and after.

## Phase 2 — AI provider abstraction

Asked for a provider-agnostic chat/embedding interface swappable across
OpenAI-compatible backends (OpenAI, Groq, Together, OpenRouter, Ollama,
custom) with one retry policy and one error shape. An independent
re-validation pass (same rigor as D1.5, deliberately not trusting the
first pass's own tests) found that `stream()`'s initial request wasn't
wrapped in the same error-mapping `complete()` used, so `withRetry` never
recognized a streaming rate-limit error as retryable — streaming silently
never retried while non-streaming did (D2.6). Fixed and added two
regression tests, one of which was verified to actually fail against the
pre-fix code before trusting it as a real regression test.

## Phase 3 — API, auth, documents CRUD

Asked for the NestJS API shell: JWT auth via Supabase (with a local
HS256 fallback for environments without a hosted project), RLS-scoped
Supabase clients per request, the documents CRUD module with zod
validation, a central exception-to-HTTP-response filter, and rate
limiting. Two real bugs only surfaced once the Gate 3 e2e suite actually
ran the app end to end over HTTP — neither lint nor typecheck caught
either, both stayed green throughout:

- Running `eslint --fix` on a batch of `consistent-type-imports`
  warnings silently rewrote four constructor-injected classes (Reflector,
  DocumentsService, IndexingQueue, DocumentsRepository) to `import type`,
  which erases the value NestJS's DI needs at runtime to resolve them —
  invisible to both `tsc` (types were still correct) and the lint rule
  itself (it has no notion of `emitDecoratorMetadata`). Only showed up as
  the app refusing to boot in the e2e test's `beforeAll`. Fixed by
  reverting to value imports with an explicit suppressing comment at each
  site (D3.3).
- The Gate 3 "empty PATCH body should 400" test got a 200 instead:
  `DocumentUpdateSchema`'s `tags` field reused `DocumentCreateSchema`'s
  tags schema (which has `.default([])`) wrapped in `.optional()`, on the
  assumption `.optional()` short-circuits before a default fires on
  `undefined` input. Zod v4 doesn't — the default fired anyway, so an
  omitted `tags` field silently satisfied the "at least one field
  present" check. Fixed by splitting out a no-default tags schema for the
  update case, and added a unit regression test for it directly in
  `packages/shared` so this class of bug is caught before an e2e run next
  time, not only after (D3.4).

Also asked it to build a Gate 3 e2e harness that tests "through the auth
API" without Docker (this machine has neither Docker nor Podman, so
`supabase start` doesn't work at all here). It proposed and built a real
PostgREST binary + hand-minted JWTs standing in for local Supabase/GoTrue
— a genuinely higher-fidelity substitute than a bare Postgres shim would
have been, and one that exercises `AuthGuard`'s actual production
verification path (getClaims-first, HS256-fallback) rather than a
test-only code path (D3.1).

Separately asked, after the phase was "done": "is this really done,
without gaps or bugs?" — a genuine independent re-validation, not just
re-running the same tests. From a fresh clone, checked the code against
the brief's literal Phase 3 checklist rather than only Gate 3's four
bullet points, and found a real one: `AuthGuard` verified a JWT's
signature but never checked its `role` claim, so a hand-minted
`role: "service_role"` token with the well-known local signing secret
authenticated successfully — undermining the app's own "no service-role
access" invariant. Proved it concretely (a probe request, not just
reasoning about it) before fixing it, then fixed and added a permanent
regression test (D3.6). The same pass also found real endpoints with zero
test coverage (list search/tag/pagination, reindex) despite being fully
implemented — an "it works" that had never actually been exercised by a
test. This is the clearest example so far of why "the tests pass" and
"the feature is done" aren't the same claim, and why a second, skeptical
pass — ideally from a fresh clone, checked against the original spec
rather than the first pass's own checklist — catches things the first
pass's own definition of done cannot.
