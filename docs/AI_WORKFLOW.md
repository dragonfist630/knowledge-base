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

## Phase 5 — retrieval and chat

Asked to move on to "the next phase" without saying which; asked back
whether that meant retrieval + chat, and whether it should include the
Next.js web UI or just the API — answered with a link to the actual
Google Doc project brief instead of picking an option, which turned out
to be the first time the full, authoritative spec had ever actually been
read (earlier phases worked from a mix of memory and inference about
what the brief said). Retrieved it via the Google Drive connector,
confirmed Phase 5 = backend retrieval + chat only (the web chat UI is
explicitly Phase 6 in the brief's own schedule), and built the rest of
the phase against that literal spec rather than reconstructing it from
context — the exact "check the source of truth instead of inferring it"
discipline Phase 2's D2.1 (provider presets corrected against current
vendor docs) already established for a different kind of source.

Built in dependency order, same discipline as Phase 4: the pure
`@kb/rag-core` additions first (`prompt.ts` — the exact system-prompt/
message-shape the brief specifies, D5.1; `citations.ts` — the
buffering streamed-marker parser, tested by splitting messages at every
possible offset, D5.2), then `@kb/shared`'s SSE/REST contract schemas,
then `RetrievalService` (query rewrite, offset-based near-duplicate
merging, token-budgeted context packing, D5.3), then `ChatService` as
the one transport-agnostic orchestration point both `POST /chat` and
`POST /chat/stream` share (D5.5), then the controller and SSE wiring.
Building `prompt.ts` surfaced a real design tension worth naming: Phase
2's `MockChatModel` doc comment assumed retrieved context would live in
the latest user message, which conflicts with the brief's actual Phase 5
design (sources belong in the system message) — resolved in favor of the
brief, with the stale comment corrected rather than left misleading
(D5.1).

Writing the Gate 5 e2e test for "aborting mid-stream persists status
'aborted'" surfaced a real bug, not a test artifact: `ChatController`'s
SSE handler listened on `req.on("close", ...)` — the commonly-documented
way to detect a client disconnecting mid-response — and that handler
simply never fired on this stack (Express 5.2 / Node 22), so every abort
attempt persisted `'complete'` instead of `'aborted'`. A temporary debug
log confirmed the callback never ran at all; switching to
`res.on("close", ...)` (the response's own lifecycle, not the request's)
fixed it immediately, and is arguably the more correct object to listen
on regardless of the version-specific behavior (D5.6). The same debugging
pass also caught that the abort test itself, even after the fix, was
racing `MockChatModel`'s synchronous word-by-word loop and losing most
of the time — not a bug in the app, but a bug in the test's own timing
assumptions. Fixed the way Phase 4's D4.5 fixed the equivalent problem
for a forced-embedding-failure test: a small `ControllableChatModel`
wraps the real mock and, only for this one test, waits a real 300ms
before checking the abort signal, installed via Nest's own
`overrideProvider` rather than any change to `@kb/ai` itself (D5.7). The
same abort contract is additionally covered with zero timing dependency
by unit-level tests at both the controller and service layers, so the
one e2e scenario proves the real end-to-end wiring without being the
only thing standing between this behavior and a regression.

Ran the full pipeline and the Gate 5 e2e suite (26/26, including the
abort test) three times in a row after the D5.6/D5.7 fixes specifically
to confirm the abort scenario had actually stopped being flaky rather
than just happening to pass once (D5.8) — the same "don't trust a single
green run of something timing-sensitive" instinct Phase 4's D4.7 applied
to its own regression test.

Asked directly, after all of that, whether Phase 5 was "really done,
without gaps or bugs" — the same recurring skeptical-re-validation
exercise as D1.5/D2.6/D3.6-D3.7/D4.6-D4.7, run from a fresh clone of the
pushed commit rather than trusting D5.8's own green run. Reading
`packContext` adversarially turned up a real greedy-packing bug: the
budget loop `break`s the moment any block fails to fit, so one oversized
mid-ranked block wrongly knocked a smaller, still-fitting, lower-ranked
block out of the context too — proved with a standalone probe before
touching any code, fixed by changing that `break` to a `continue`, and
locked in with a three-block regression test the existing suite had no
equivalent of. Re-reading `ChatService` against its own stated
invariants (every terminal path touches the conversation) caught the
second one: `persistError` was the one path that didn't call
`repository.touch()`, so a turn that ended in an error never bumped its
conversation's `updated_at` despite real activity having just happened —
fixed by threading the conversation id into `persistError` and touching
it there too, same as the other two paths, with assertions added to the
two existing error-path tests to prove it (D5.9). Re-ran the full
pipeline and e2e suite again after both fixes — still fully green — before
reporting the verdict back rather than assuming the fixes were correct
because they looked right.

Handed a third, specific, falsifiable claim next: that `mergeAdjacent`
merges consecutive-`chunk_index` chunks without ever checking
`heading_path`, and that two adjacent chunks from different sections —
which the chunker never overlaps and never puts heading text into —
would get merged anyway, corrupting both the reported `headingPath` and
the content sent to the model. Asked only to validate it, not fix it —
read `mergeAdjacent`'s actual merge condition to confirm it really was
`chunkIndex`-only, read `chunker.ts` to confirm the chunker's own
stated behavior the claim leaned on, then wrote a probe feeding the
real `chunkDocument()` output straight into the real `RetrievalService`
rather than trusting a synthetic fixture. It reproduced exactly what
was claimed: a merged source reporting only the first chunk's
`headingPath`, with the second section's literal `"## Section B"`
heading line spliced into the content the model would receive as a
source. Confirmed both fields matter, not just cosmetically —
`headingPath` feeds `prompt.ts`'s `<source section="...">` attribute
and the citation location shown to the user. Reported the claim
accurate with no code touched, the same validate-before-fixing
discipline D4.7 used for its own externally-sourced claim.

Asked to fix it. Added a `headingPath` equality check alongside the
existing `chunkIndex` adjacency check in `mergeAdjacent` — the two
conditions together are what the chunker can actually guarantee shared
text between. Proved the new regression tests weren't vacuous by
running them against the pre-fix code first (both failed, reproducing
the exact reported symptom) before confirming they passed against the
fix — one synthetic-fixture test matching the file's existing style,
and one end-to-end test built on the real chunker output, since a
hand-crafted fixture alone wouldn't have proven the fix addresses what
production actually does (D5.10). Full pipeline and e2e suite both
clean afterward.

Asked one more time, mid-Phase-6, whether Phase 5 held up — dispatched
to a fresh subagent with no memory of D5.9/D5.10's fixes, cross-checked
personally. Both fixes still in place, still covered by their tests, no
new issues (D5.11). Fourth time this exact question has been asked of
Phase 5; fourth time the answer required actually checking rather than
assuming yesterday's "yes" still holds.

## Phase 6 — the web UI, Usage, seeding, and Gate 6

Built the Next.js App Router frontend the brief's Phase 6 spec
describes — auth (signup/login/logout via `@supabase/ssr`), documents
CRUD with a Markdown write/preview editor, chat with SSE streaming and
inline citations, and a responsive shell that collapses to an
off-canvas nav on mobile — against TanStack Query as the one place
server state lives, matching the state-management rule the rest of the
app already follows (D6.1).

Asked to validate Phase 5 again, this time with real UI screenshots
rather than DOM captures, every screenshot looked correct — until the
first attempted click did nothing at all. Traced it to a genuine Next
16 dev-server gotcha: `experimental.reactDebugChannel` defaults to
`true`, and client hydration awaits a WebSocket "debug channel" whose
handshake never completes in this sandbox specifically (proved with a
standalone WebSocket probe, ruling out CORS/IndexedDB/general
WebSocket brokenness) — so the app stays server-rendered HTML forever,
looking right and doing nothing, with zero console error to explain
why. Fixed with one config flag, verified by checking for hydrated
React fiber props and confirming a dropdown actually opens, then
captured all 19 requested screenshots against a genuinely interactive
app (D6.2). Also ran a third independent re-validation pass on Phase 5
itself during this same stretch of work (folded into D5.11 above,
Phase 5's own section) — still clean.

Asked next whether to "move on to the next phase" — answered with a
clarifying question rather than guessing, since the brief has no Phase
7 and Phase 6 itself wasn't finished yet (no Usage page, `seed.mjs`
still a placeholder, no Gate 6). Given the choice to finish Phase 6
first, in order: the backend `UsageModule` (one `security invoker` RPC,
grouped by day/operation/model, summed in the service layer, not
duplicated across the DB and app — D6.3) and its frontend page; then
`scripts/seed.mjs`, rewritten from its Phase 0 placeholder to talk
directly to Supabase Auth's REST endpoints and create real sample
documents through the real indexing pipeline (D6.4).

Closed with Gate 6: a real Chromium session driven by Playwright
against a real apps/api, real PostgREST/RLS, and one new piece of test
infrastructure Gate 3 never needed — a GoTrue-compatible auth shim,
because apps/web's browser Supabase client makes a live `/auth/v1/user`
round trip on every auth check, unlike apps/api's own local-JWT
fallback (D6.5). The very first run of the resulting smoke test — sign
up, load and index sample documents, open and edit and save one, ask a
question in chat, check the usage page, sign out and back in, delete
the document, check mobile nav — caught a real, previously-undetected
production bug on its very first pass: saving an *already-existing*
document silently failed every time. Traced with a temporary debug log
(the failure was being swallowed into a toast that auto-dismissed
before the test's own assertion timeout fired) to a query-cache-key
collision: an optimistic-update helper matched both the document list
queries and the single open document's own cache entry under the same
overly-broad key, then crashed trying to treat the single document like
a paginated list. Neither the unit tests (isolated fake query clients)
nor the earlier manual screenshot pass (which exercised *creating* a
document, a different code path) could have caught this — only a real
browser driving a real, populated TanStack Query cache through the
actual edit flow. Fixed by giving list queries their own dedicated
cache-key prefix, verified by re-running the now-green smoke test and
the full 19-task pipeline (D6.5).

Asked again — "validate if Phase 6 is really done" — pushed to c63ec82
and re-checked from three independent angles, not just "run it again."
First, a fresh clone plus a from-scratch Gate 6 run (deleting the
`.next-e2e` build cache to simulate what every real CI run actually
looks like, not the warm-cache runs earlier verification had relied
on) reproducibly timed out mid-suite — not at the same step twice,
which pointed at a budget problem rather than a logic bug. Traced to
Next's dev server compiling each of the smoke test's ~7 routes on
first request, which a cold `.next-e2e` cache has no head start on;
raised the per-test timeout from 30s to 90s and confirmed three
fully-cold runs in a row landed comfortably inside it (D6.7).

Second, dispatched an independent subagent with no memory of this
session to adversarially read the Phase 6 frontend for the same class
of bug D6.5 had just found — state silently lost across a
discontinuity the code assumed was continuous. It found one: a
brand-new conversation's `router.replace` from `/chat` to
`/chat/[id]`, fired the instant the SSE `start` event reported the
server-assigned id (the very first event of every turn), was a real
Next.js navigation between two separate route files — unmounting the
in-flight `useChatStream` instance mid-stream, so every subsequent
token, citation, and even a mid-turn error were dispatched into a dead
component and silently dropped. Verified personally rather than taking
the report on faith: read the actual files, confirmed no shared layout
sits between the two chat routes, then wrote a diagnostic script
polling the message area through a live send — it reproduced the exact
symptom, content visibly reverting right as the URL flipped. Fixed by
adopting the conversation id as local state and updating the address
bar with `history.replaceState` instead of a real navigation, so the
component never unmounts. Added a permanent regression test and proved
it wasn't vacuous the same way D5.9/D5.10 did: ran it against the
pre-fix code first (failed, same symptom) before confirming it passed
against the fix (D6.6).

Third, ran the full pipeline and Gate 6 suite clean from that same
fresh clone one more time after both fixes, then transferred, verified
again on the Mac, committed, and pushed. Verdict: Phase 6 had two real
gaps this pass — one a genuine app bug (D6.6), one a test-harness
robustness gap that would have made CI flaky rather than the app itself
wrong (D6.7) — both fixed, both covered by regression tests proven
non-vacuous, both confirmed via a truly fresh clone rather than the
same working directory that had already seen the fix applied.
