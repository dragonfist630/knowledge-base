-- D9.14 (Phase 9): document_indexing_jobs + claim_indexing_jobs.
--
-- Run with `pnpm db:test` (wraps `supabase test db`, which enables pgTAP).
--
-- What this covers: RLS isolation (same shape as rls_isolation.test.sql,
-- but exercising the insert-check's join against `documents` specifically),
-- upsert-by-document_id giving "latest job wins" semantics, and
-- claim_indexing_jobs's actual claiming behavior — a pending job gets
-- claimed and flips to 'processing'; an already-'processing', NOT-stale
-- job is left alone; a 'processing' job that's gone stale (past
-- p_stale_after) becomes claimable again; and a document's own delete
-- cascades to its job row.
--
-- What this does NOT cover, and can't from here: true concurrent claiming
-- from two separate sessions racing on the same row set (the actual "for
-- update skip locked, disjoint results" guarantee). pgTAP runs this whole
-- file in one transaction/session, so there's no way to hold a second,
-- genuinely concurrent transaction open from inside it. That was verified
-- live instead, with two real concurrent psql sessions against a scratch
-- database seeded from these same migrations — see docs/DECISIONS.md
-- D9.14 for that run's output.

begin;
select plan(12);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'user-a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'user-b@example.com');

insert into public.documents (id, user_id, title, content, content_hash) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-00000000000a', 'A doc', 'x', 'hash-a1');

-- Act as user A: enqueue a job for A's own document. -----------------------

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-00000000000a', 'role', 'authenticated')::text,
  true
);
set local role authenticated;

insert into public.document_indexing_jobs (document_id, content_hash)
values ('00000000-0000-0000-0000-0000000000d1', 'hash-a1');

-- Upsert-by-document_id (latest job wins): a second enqueue for the same
-- document replaces the row's content_hash rather than adding a second
-- row.
insert into public.document_indexing_jobs (document_id, content_hash)
values ('00000000-0000-0000-0000-0000000000d1', 'hash-a1-edited')
on conflict (document_id) do update set
  content_hash = excluded.content_hash, status = 'pending', locked_at = null, attempts = 0, error = null;

select is(
  (select count(*) from public.document_indexing_jobs where document_id = '00000000-0000-0000-0000-0000000000d1'),
  1::bigint,
  'upserting a second job for the same document_id replaces it — exactly one row, not two'
);

select is(
  (select content_hash from public.document_indexing_jobs where document_id = '00000000-0000-0000-0000-0000000000d1'),
  'hash-a1-edited',
  'the upsert replaced content_hash with the newer value'
);

reset role;

-- Act as user B: RLS isolation. --------------------------------------------

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-00000000000b', 'role', 'authenticated')::text,
  true
);
set local role authenticated;

select is(
  (select count(*) from public.document_indexing_jobs where document_id = '00000000-0000-0000-0000-0000000000d1'),
  0::bigint,
  'user B cannot see user A''s job row'
);

select throws_ok(
  $t$insert into public.document_indexing_jobs (document_id, content_hash)
    values ('00000000-0000-0000-0000-0000000000d1', 'sneaky')$t$,
  '42501',
  null,
  'user B cannot enqueue a job against user A''s document'
);

select is(
  (select count(*) from public.claim_indexing_jobs(5)),
  0::bigint,
  'user B''s claim_indexing_jobs returns nothing — RLS scopes claiming to the caller''s own rows even though A has a pending job'
);

reset role;

-- Back to user A: claiming behavior. ----------------------------------------

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-00000000000a', 'role', 'authenticated')::text,
  true
);
set local role authenticated;

select is(
  (select count(*) from public.claim_indexing_jobs(5)),
  1::bigint,
  'claim_indexing_jobs claims the one pending job'
);

select is(
  (select status from public.document_indexing_jobs where document_id = '00000000-0000-0000-0000-0000000000d1'),
  'processing',
  'a claimed job flips to processing'
);

select is(
  (select attempts from public.document_indexing_jobs where document_id = '00000000-0000-0000-0000-0000000000d1'),
  1,
  'claiming increments attempts'
);

select is(
  (select count(*) from public.claim_indexing_jobs(5)),
  0::bigint,
  'a fresh (not stale) processing job is not claimable again'
);

-- Simulate a crashed worker: back-date locked_at well past the default
-- staleness threshold (5 minutes) and confirm the job becomes claimable
-- again — this is the mechanism that gives resumeStuckIndexing's sweep
-- (documents.service.ts) its crash-recovery behavior.
update public.document_indexing_jobs
set locked_at = now() - interval '10 minutes'
where document_id = '00000000-0000-0000-0000-0000000000d1';

select is(
  (select count(*) from public.claim_indexing_jobs(5)),
  1::bigint,
  'a stale processing job (locked_at past p_stale_after) is claimable again'
);

-- Completion is a plain delete guarded by content_hash — proving that
-- guard here at the schema/query level, since it's what stops a stale
-- job's completion from deleting a newer job someone else already
-- upserted for the same document (see indexing.repository.ts's
-- completeJob).
delete from public.document_indexing_jobs
where document_id = '00000000-0000-0000-0000-0000000000d1' and content_hash = 'a-content-hash-nobody-has';

select is(
  (select count(*) from public.document_indexing_jobs where document_id = '00000000-0000-0000-0000-0000000000d1'),
  1::bigint,
  'a completion delete guarded by the WRONG content_hash is a no-op — the row survives'
);

-- Deleting the parent document cascades to its job row.
delete from public.documents where id = '00000000-0000-0000-0000-0000000000d1';

select is(
  (select count(*) from public.document_indexing_jobs where document_id = '00000000-0000-0000-0000-0000000000d1'),
  0::bigint,
  'deleting the parent document cascades to delete its job row'
);

select * from finish();
rollback;
