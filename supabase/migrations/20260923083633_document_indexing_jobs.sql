-- D9.14 (Phase 9): a persisted indexing queue, replacing the in-memory
-- `p-queue` `IndexingQueue` has run on since Phase 4. See
-- docs/DECISIONS.md D9.14 for the full writeup, including why pg-boss (the
-- fix docs/SCALING.md item 1 originally named) was investigated and
-- rejected: it needs a direct `DATABASE_URL` Postgres connection with
-- schema-creation rights, which conflicts with this app's one
-- unconditional invariant since Phase 1 (D3.6) — RLS, enforced through
-- Supabase's PostgREST client under the calling user's own JWT, is the
-- ONLY authorization boundary anywhere in apps/api; there is no
-- service-role or elevated client anywhere, and this table is not going to
-- be the first.
--
-- document_indexing_jobs is a normal RLS-scoped table, indexed and queried
-- exactly like every other table in this schema. Its primary key is
-- document_id, not a generated id — a table is either an append-only log
-- or has "at most one row per key" upsert semantics, and this one wants
-- the latter: enqueuing a job for a document that already has one pending
-- should replace it, not queue a second one, mirroring the in-memory
-- queue's own `pendingByDocument` Map (Phase 4) exactly. A plain
-- `.upsert(..., { onConflict: 'document_id' })` gets that for free.
--
-- Deliberately NO stored JWT/credential column. An earlier sketch of this
-- design (see docs/DECISIONS.md D9.14) planned one, reasoning that a job
-- might be claimed and processed by a later request than the one that
-- enqueued it. Working through the actual call sites before writing this
-- migration showed that's not the case: every path that claims a job
-- (the immediate kick right after enqueue, and the resumeStuckIndexing
-- sweep) already has a live, already-verified JWT for the SAME user in
-- hand at the moment of processing — claim_indexing_jobs itself only ever
-- returns that caller's own rows (RLS), so "whoever successfully claimed
-- it" and "whose JWT would be needed to process it" are always the same
-- request. Storing a credential nobody ever reads back would be pure
-- unused at-rest exposure, so this table holds none.
create table public.document_indexing_jobs (
  document_id  uuid primary key references public.documents(id) on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  content_hash text not null,
  status       text not null default 'pending' check (status in ('pending', 'processing', 'failed')),
  attempts     int not null default 0 check (attempts >= 0),
  error        text,
  locked_at    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Claiming (see claim_indexing_jobs below) filters on user_id/status and
-- orders by created_at — this index covers that query directly. RLS
-- already restricts every query to the caller's own rows; this index
-- exists for the query planner, not for correctness.
create index document_indexing_jobs_user_status_idx
  on public.document_indexing_jobs (user_id, status, created_at);

-- Every write to this table (status flips, lock/attempt bookkeeping on
-- claim, error text on failure) is system-driven, not a user edit to
-- content — unlike documents' updated_at trigger, there's no "don't bump
-- this on a background write" distinction to make here. Plain
-- set_updated_at() (already defined in the init migration) is correct
-- as-is.
create trigger document_indexing_jobs_set_updated_at
  before update on public.document_indexing_jobs
  for each row execute function public.set_updated_at();

-- RLS --------------------------------------------------------------------

alter table public.document_indexing_jobs enable row level security;

create policy document_indexing_jobs_select on public.document_indexing_jobs for select to authenticated
  using ((select auth.uid()) = user_id);
create policy document_indexing_jobs_insert on public.document_indexing_jobs for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.documents d
      where d.id = document_id and d.user_id = (select auth.uid())
    )
  );
create policy document_indexing_jobs_update on public.document_indexing_jobs for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy document_indexing_jobs_delete on public.document_indexing_jobs for delete to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.document_indexing_jobs to authenticated;

-- RPC: claim_indexing_jobs -------------------------------------------------
--
-- Atomically claims up to p_limit of the CALLING USER's own jobs that are
-- either 'pending', or 'processing' but stuck past p_stale_after (a
-- process that died mid-job, or a job claimed by a replica that then
-- crashed before finishing it) — flipping each to 'processing', stamping
-- locked_at = now(), and incrementing attempts, in one statement. Multiple
-- concurrent callers (two apps/api replicas, or two requests from the same
-- user racing) claiming from the same row set is exactly what `for update
-- skip locked` exists for: each caller gets a disjoint set of rows, none
-- of them block on each other, and nobody double-processes the same
-- document — the atomicity this whole table exists to add over the old
-- in-memory queue's implicit single-process safety. This is the same
-- `security invoker` + `set search_path` pattern every other RPC in this
-- schema uses (see replace_document_chunks/match_document_chunks above) —
-- RLS still applies to every row this function touches, so a caller can
-- only ever claim their own rows regardless of what this function's SQL
-- looks like; the explicit `user_id = (select auth.uid())` filter below is
-- redundant with that but kept for the same reason the retrieval RPCs keep
-- theirs: it lets the query plan use the index above instead of relying on
-- the planner to push the RLS qual down on its own.
create function public.claim_indexing_jobs(
  p_limit int default 2,
  p_stale_after interval default '5 minutes'
) returns table (
  document_id  uuid,
  content_hash text,
  attempts     int
)
language sql
security invoker
set search_path = public, extensions
as $$
  with candidates as (
    select j.document_id
    from public.document_indexing_jobs j
    where j.user_id = (select auth.uid())
      and (
        j.status = 'pending'
        or (j.status = 'processing' and j.locked_at < now() - p_stale_after)
      )
    order by j.created_at
    limit p_limit
    for update skip locked
  )
  update public.document_indexing_jobs j
  set status = 'processing',
      locked_at = now(),
      attempts = j.attempts + 1
  from candidates c
  where j.document_id = c.document_id
  returning j.document_id, j.content_hash, j.attempts;
$$;

revoke execute on function public.claim_indexing_jobs(int, interval) from public, anon;
grant execute on function public.claim_indexing_jobs(int, interval) to authenticated;
