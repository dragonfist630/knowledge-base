-- Regression test for the documents.updated_at trigger: a status-only
-- write from the indexing pipeline must NOT look like a user edit, but a
-- real title/content/tags change must still bump updated_at.
--
-- Uses a sentinel timestamp instead of pg_sleep()+now() to detect a bump:
-- now() is frozen at transaction start for the whole test (pgTAP wraps
-- everything in one begin/rollback), so pg_sleep() never actually moves it
-- and a "did it change" check has to compare against a value we control
-- instead of wall-clock time.
--
-- Run with `pnpm db:test` (wraps `supabase test db`, which enables pgTAP).

begin;
select plan(3);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'user-a@example.com');

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-00000000000a', 'role', 'authenticated')::text,
  true
);
set local role authenticated;

insert into public.documents (id, title, content, content_hash)
values ('00000000-0000-0000-0000-0000000000d1', 'Original title', 'hello world', 'hash-a');

-- Force updated_at to a sentinel far in the past. This update itself
-- changes only updated_at (title/content/tags untouched), so the trigger's
-- condition is false and it leaves our explicit assignment alone.
update public.documents
set updated_at = '2020-01-01T00:00:00Z'
where id = '00000000-0000-0000-0000-0000000000d1';

-- A pipeline-style status-only write (what replace_document_chunks does on
-- success) must leave updated_at at the sentinel, untouched.
update public.documents
set index_status = 'ready', chunk_count = 1, indexed_at = now()
where id = '00000000-0000-0000-0000-0000000000d1';

select is(
  (select updated_at from public.documents where id = '00000000-0000-0000-0000-0000000000d1'),
  '2020-01-01T00:00:00Z'::timestamptz,
  'a status-only update does not bump documents.updated_at'
);

-- A real content edit must still bump it away from the sentinel.
update public.documents
set content = 'hello world, edited'
where id = '00000000-0000-0000-0000-0000000000d1';

select isnt(
  (select updated_at from public.documents where id = '00000000-0000-0000-0000-0000000000d1'),
  '2020-01-01T00:00:00Z'::timestamptz,
  'a real content edit does bump documents.updated_at'
);

-- conversations keeps its old, unconditional behavior: any update (e.g. the
-- "touch updated_at" write a finished chat turn makes) bumps it, even one
-- that doesn't change title.
insert into public.conversations (id, title)
values ('00000000-0000-0000-0000-00000000c0d1', 'A conversation');

update public.conversations
set updated_at = '2020-01-01T00:00:00Z'
where id = '00000000-0000-0000-0000-00000000c0d1';

select isnt(
  (select updated_at from public.conversations where id = '00000000-0000-0000-0000-00000000c0d1'),
  '2020-01-01T00:00:00Z'::timestamptz,
  'conversations.updated_at still bumps on any update (unchanged behavior)'
);

select * from finish();
rollback;
