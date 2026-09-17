-- Functional regression tests for match_document_chunks beyond what
-- rls_isolation.test.sql covers there (it only checks that user B gets 0
-- rows for user A's data). These check the filter parameters actually work
-- for a user's OWN data, including the two-stage filter_tags path added
-- when the query was rewritten to keep the semantic/keyword branches
-- index-friendly (see docs/DECISIONS.md D1.7).
--
-- Run with `pnpm db:test` (wraps `supabase test db`, which enables pgTAP).

begin;
select plan(6);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'user-a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'user-b@example.com');

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-00000000000a', 'role', 'authenticated')::text,
  true
);
set local role authenticated;

insert into public.documents (id, title, content, content_hash, tags)
values ('00000000-0000-0000-0000-0000000000d1', 'Tagged doc', 'hello world', 'hash-a', array['important']);

insert into public.document_chunks (
  id, document_id, chunk_index, content, token_count, char_start, char_end, embedding, embedding_model
) values (
  '00000000-0000-0000-0000-0000000000c1',
  '00000000-0000-0000-0000-0000000000d1',
  0, 'hello world', 2, 0, 11,
  array_fill(0.01, array[1536])::extensions.vector, 'test-model'
);

reset role;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-00000000000b', 'role', 'authenticated')::text,
  true
);
set local role authenticated;

insert into public.documents (id, title, content, content_hash, tags)
values ('00000000-0000-0000-0000-0000000000d2', 'B''s doc', 'other content', 'hash-b', array['unrelated']);

insert into public.document_chunks (
  id, document_id, chunk_index, content, token_count, char_start, char_end, embedding, embedding_model
) values (
  '00000000-0000-0000-0000-0000000000c2',
  '00000000-0000-0000-0000-0000000000d2',
  0, 'other content', 2, 0, 13,
  array_fill(0.02, array[1536])::extensions.vector, 'test-model'
);

reset role;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-00000000000a', 'role', 'authenticated')::text,
  true
);
set local role authenticated;

select is(
  (select count(*) from public.match_document_chunks(
    array_fill(0.01, array[1536])::extensions.vector, 'hello', 8, 0.25, null, array['important']
  )),
  1::bigint,
  'filter_tags matching one of the user''s own document''s tags returns it'
);

select is(
  (select count(*) from public.match_document_chunks(
    array_fill(0.01, array[1536])::extensions.vector, 'hello', 8, 0.25, null, array['no-such-tag']
  )),
  0::bigint,
  'filter_tags with no matching tag returns nothing'
);

select is(
  (select count(*) from public.match_document_chunks(
    array_fill(0.01, array[1536])::extensions.vector, 'hello', 8, 0.25,
    array['00000000-0000-0000-0000-0000000000d1']::uuid[]
  )),
  1::bigint,
  'filter_document_ids matching the user''s own document returns it'
);

select is(
  (select count(*) from public.match_document_chunks(
    array_fill(0.01, array[1536])::extensions.vector, 'hello', 8, 0.25,
    array['00000000-0000-0000-0000-0000000000d2']::uuid[]
  )),
  0::bigint,
  'filter_document_ids naming another user''s document (even if guessed) returns nothing — RLS plus the explicit filter both exclude it'
);

select is(
  (select count(*) from public.match_document_chunks(
    array_fill(0.01, array[1536])::extensions.vector, 'hello', 0
  )),
  0::bigint,
  'match_count=0 returns no rows without erroring'
);

select is(
  (select count(*) from public.match_document_chunks(
    array_fill(0.01, array[1536])::extensions.vector, 'hello', 8
  )),
  1::bigint,
  'no filters at all still returns the user''s own matching chunk'
);

select * from finish();
rollback;
