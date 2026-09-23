-- Functional regression tests for match_document_chunks beyond what
-- rls_isolation.test.sql covers there (it only checks that user B gets 0
-- rows for user A's data). These check the filter parameters actually work
-- for a user's OWN data, including the two-stage filter_tags path added
-- when the query was rewritten to keep the semantic/keyword branches
-- index-friendly (see docs/DECISIONS.md D1.7).
--
-- Run with `pnpm db:test` (wraps `supabase test db`, which enables pgTAP).
--
-- Also covers D6.15 (docs/DECISIONS.md Phase 6): document_chunks now
-- carries the content_hash it was chunked from, and match_document_chunks
-- only returns chunks whose content_hash still matches their document's
-- CURRENT content_hash — a chunk left over from before an edit (indexing
-- still in flight, or failed outright) must never be retrievable, since
-- retrieval.service.ts re-slices merged blocks out of the document's
-- CURRENT content using that chunk's char offsets, which are only valid
-- against the content it was actually chunked from.
--
-- And D9.11 (docs/DECISIONS.md Phase 9): match_document_chunks now also
-- RETURNS each matched chunk's own content_hash, so retrieval.service.ts
-- can detect the narrower race D6.15 doesn't close — a save landing
-- between this RPC call and packContext's own separate read of the
-- document's current content, which would otherwise re-slice the NEW
-- content using offsets that were only ever valid against the OLD one.

begin;
select plan(9);

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
  id, document_id, chunk_index, content, token_count, char_start, char_end, embedding, embedding_model, content_hash
) values (
  '00000000-0000-0000-0000-0000000000c1',
  '00000000-0000-0000-0000-0000000000d1',
  0, 'hello world', 2, 0, 11,
  array_fill(0.01, array[1536])::extensions.vector, 'test-model', 'hash-a'
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
  id, document_id, chunk_index, content, token_count, char_start, char_end, embedding, embedding_model, content_hash
) values (
  '00000000-0000-0000-0000-0000000000c2',
  '00000000-0000-0000-0000-0000000000d2',
  0, 'other content', 2, 0, 13,
  array_fill(0.02, array[1536])::extensions.vector, 'test-model', 'hash-b'
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

-- D9.11: the RPC's own output includes each matched chunk's content_hash
-- (not just documents/document_chunks internally, where D6.15's freshness
-- filter already used it) — retrieval.service.ts's packContext needs this
-- to detect a save landing after this RPC call but before its own,
-- separate re-fetch of the document's current content.
select is(
  (select content_hash from public.match_document_chunks(
    array_fill(0.01, array[1536])::extensions.vector, 'hello', 8, 0.25,
    array['00000000-0000-0000-0000-0000000000d1']::uuid[]
  )),
  'hash-a',
  'match_document_chunks returns the matched chunk''s own content_hash (D9.11)'
);

-- D6.15: a chunk whose content_hash no longer matches its document's
-- current content_hash (edited since this chunk was produced; reindex
-- still pending/in-flight/failed) must not be retrievable, even though it
-- otherwise matches on user_id/embedding/document_id exactly like c1 does.
update public.documents set content_hash = 'hash-a-edited' where id = '00000000-0000-0000-0000-0000000000d1';

select is(
  (select count(*) from public.match_document_chunks(
    array_fill(0.01, array[1536])::extensions.vector, 'hello', 8, 0.25,
    array['00000000-0000-0000-0000-0000000000d1']::uuid[]
  )),
  0::bigint,
  'a chunk whose content_hash no longer matches its document''s current content_hash is excluded (D6.15)'
);

-- Restore the hash and confirm the SAME chunk is retrievable again once its
-- content_hash matches the document's current one — proves the exclusion
-- above is really about hash freshness, not e.g. an accidental cascading
-- side effect of the update itself.
update public.documents set content_hash = 'hash-a' where id = '00000000-0000-0000-0000-0000000000d1';

select is(
  (select count(*) from public.match_document_chunks(
    array_fill(0.01, array[1536])::extensions.vector, 'hello', 8, 0.25,
    array['00000000-0000-0000-0000-0000000000d1']::uuid[]
  )),
  1::bigint,
  'the same chunk is retrievable again once content_hash matches its document''s current content_hash (D6.15)'
);

select * from finish();
rollback;
