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

A third pass on the same phase, prompted by a specific claim to verify
("does this file really still have a raw NUL byte in it, wasn't that
supposedly fixed?"), found a genuinely strange one: `documents.service.ts`
compiled, typechecked, built, and passed every test the whole time, but
had a literal raw `0x00` byte sitting inside a string literal instead of
the printable escape sequence `\0` — invisible in every editor and every
tool output along the way, only visible to `file`/`grep -a`/a byte-level
read. It never mattered at runtime (verified the hash output is
byte-for-byte identical either way), but it's a good reminder that
"the pipeline is green" only checks what the pipeline can see — a raw
control byte inside a valid string literal is invisible to `tsc`,
`eslint`, and a test suite that only checks behavior. Fixed, and added a
small automated check for this exact class of thing (D3.7) rather than
relying on a person noticing an odd `file` classification next time.

## Phase 4 — indexing pipeline (chunk -> embed -> store)

Asked for the real chunk -> embed -> atomically-store pipeline the
previous three phases had deliberately deferred (`IndexingQueue` was a
Phase 3 stub that only remembered the latest job per document and never
processed anything — D3.2). Built in dependency order: the pure
`@kb/rag-core` chunker first (markdown-aware, token-budgeted via
`gpt-tokenizer`, offset-tracked back to the original content — D4.1),
then the real `p-queue`-backed `IndexingQueue` (concurrency 2, per-
document "latest job wins" — D4.2), then `IndexingService` as the
processor, late-bound in to avoid a circular dependency between the two
(D4.2), then a Gate 4 e2e suite exercising the whole thing end to end
against the same real Postgres+RLS+PostgREST harness Gate 3 already
built (D4.5).

One design question turned out to be a real architectural dead end
rather than just an implementation detail: the brief's own trade-off
note asked for "a startup sweep that re-enqueues stuck documents," since
the in-process queue loses everything on restart. A literal boot-time
sweep needs a query that can see every user's stuck documents at once —
which this app structurally cannot do without a service-role client, and
this app has deliberately never had one (RLS is the only authorization
boundary anywhere in apps/api, reaffirmed as recently as Phase 3's D3.6).
Rather than quietly adding a privileged credential just to satisfy a
resiliency nice-to-have, the sweep instead runs lazily and per-user, using
each request's own already-verified JWT to resume that same user's own
stuck documents the next time they touch the API (D4.4) — a real,
honestly-documented trade-off (a document whose owner never returns
stays stuck) rather than a security shortcut.

A subtler correctness bug surfaced only once the chunker was tested
against an intentionally oversized fenced code block: the greedy packer
was deciding whether a piece fit the token budget by summing each
piece's own token count in isolation, but the actual chunk text also
includes the separator between packed pieces (a blank line, etc.), and
BPE token merges can occur across a piece boundary too — both meant the
REAL token count of a finished chunk could end up one or more tokens
over the budget even though the bookkeeping said it fit (a failing test
caught this directly: 601 tokens where the hard max was 600). Fixed by
checking the actual candidate slice's real token count instead of a
running sum, plus a binary-search safety net on the overlap step for the
same underlying reason.

Also rewrote part of Phase 3's own `documents.e2e-spec.ts`: its CRUD
test used to observe indexing by reaching into the running app's
`IndexingQueue` and calling a test-only `peek()` method, which was fine
when nothing was actually consuming the queue (Phase 3) but becomes
meaningless once a fast mock embedder actually processes jobs almost
instantly — by the time a test could call `peek()`, the job it wanted to
observe had usually already finished. Rewrote those assertions to poll
the same HTTP-visible fields (`indexStatus`/`chunkCount`/`indexedAt`) a
real client would see instead (D4.5), which is a strictly stronger test
than the one it replaced: it now proves a tags-only edit leaves
`indexedAt` completely unchanged, not just that an internal hash "looks"
unchanged.

Separately asked, once Phase 4 was "done": "is this really done, without
gaps or bugs?" — same standard as Phase 3's third-and-fourth passes
(D3.6, D3.7), not just re-running the suite that was written alongside
the feature. From a fresh clone, re-read every new file adversarially
and wrote small standalone probe scripts to test specific hypotheses
against the actual built output rather than just reasoning about the
source. Found a real one this time too: `IndexingService` recorded the
`ai_usage_events` row BEFORE writing the actual chunks, inside the same
error-handling scope — so a transient failure in that purely
observational accounting insert discarded a perfectly good, already-
computed embed pass and marked the document `'failed'` without
`replace_document_chunks` ever even being attempted (D4.6). Proved it
with a standalone script instantiating the real service with a
`recordUsage` that throws before touching any source, the same
falsification-first discipline as every other bug found this way in this
project. Fixed by moving usage recording to run after the write, on a
strict best-effort basis (log and swallow, never rethrow) — a hiccup in
logging a cost can no longer take down the actual indexing result. Also
found and fixed a smaller one the same pass: a malformed heading with no
title text after the hashes left a dangling empty segment in
`headingPath` instead of being filtered out. Both got permanent
regression tests (a new `indexing.service.spec.ts` — Phase 4's service
layer had zero unit tests before this, only e2e coverage — plus a
`chunker.spec.ts` case), and a third gap got closed without being a bug
exactly: nothing had ever asserted `ai_usage_events` actually receives a
row, despite it being a real, documented part of the pipeline, so
`indexing.e2e-spec.ts` now queries it directly (under the test user's
own RLS, not a privileged bypass) rather than only asserting on fields
the DTO happens to expose.

A fourth pass on this phase started differently: instead of a broad "is
this done" prompt, it was given one specific, falsifiable claim from
outside the conversation — that the trailing-merge loop right after the
chunker's trim step could still produce a chunk over the hard token cap,
because it only checked the small trailing chunk's own isolated token
count, never the actual merged result. Asked to "just and only validate
this claim," so no code was touched during that pass: read the loop
directly (no `maxTokens` check existed in it, confirming the shape of
the claim), then wrote standalone probe scripts sweeping a near-budget
fenced code block followed by a short closing sentence at production
defaults, which reproduced real overflow (602 tokens, up to 618 across a
wider sweep, against a 600 cap), plus an isolating probe that ruled out
chunk overlap as an alternate explanation. Reported the claim as
accurate and stopped there, exactly as asked.

Only once asked separately "can you fix it" and then given explicit
go-ahead did any code change. The bug turned out to be the identical
class of mistake as the very first Phase 4 bug (`packPieces`'s
over-budget chunks, above): a token-budget decision made by summing or
checking pieces in isolation instead of checking the real, final
concatenated text — the separator between a small trailing chunk and its
predecessor, and any BPE merge across that join, both cost real tokens
once they're one contiguous string, and neither shows up if you only
ever look at the two pieces separately (D4.7). Fixed by checking the
actual prospective merged slice's real token count and skipping the
merge (leaving the small chunk standing alone, which is still a
perfectly valid chunk) whenever merging would cross `maxTokens`.
Verified two ways before trusting it: re-ran the exact sweep that had
found overflow up to 618 tokens and confirmed it now finds none, and
wrote a permanent regression test that was deliberately run against the
pre-fix code first to confirm it actually fails there (602/600, matching
the original report) before confirming it passes against the fix — the
same "prove the regression test is real" discipline used for Phase 2's
D2.6 fix. Full pipeline and the e2e suite were both re-run clean
afterward.
