-- RLS isolation test: user B must never see or attach data to user A's rows.
-- Run with `pnpm db:test` (wraps `supabase test db`, which enables pgTAP).

begin;
select plan(6);

-- Seed two auth users directly, as the migration/owner role running this
-- file (bypasses RLS, which is fine — we're only establishing fixtures).
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'user-a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'user-b@example.com');

-- Act as user A: create a document, a chunk on it, and a conversation.
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-00000000000a', 'role', 'authenticated')::text,
  true
);
set local role authenticated;

insert into public.documents (id, title, content, content_hash)
values ('00000000-0000-0000-0000-0000000000d1', 'A''s doc', 'hello world', 'hash-a');

insert into public.document_chunks (
  id, document_id, chunk_index, content, token_count, char_start, char_end,
  embedding, embedding_model
) values (
  '00000000-0000-0000-0000-0000000000c1',
  '00000000-0000-0000-0000-0000000000d1',
  0, 'hello world', 2, 0, 11,
  array_fill(0.01, array[1536])::extensions.vector, 'test-model'
);

insert into public.conversations (id, title)
values ('00000000-0000-0000-0000-00000000c0d1', 'A''s conversation');

reset role;

-- Act as user B: none of the above should be visible or writable.
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-00000000000b', 'role', 'authenticated')::text,
  true
);
set local role authenticated;

select is(
  (select count(*) from public.documents where id = '00000000-0000-0000-0000-0000000000d1'),
  0::bigint,
  'user B cannot see user A''s document'
);

select is(
  (select count(*) from public.document_chunks where document_id = '00000000-0000-0000-0000-0000000000d1'),
  0::bigint,
  'user B cannot see user A''s chunks'
);

select throws_ok(
  $t$insert into public.document_chunks (
      document_id, chunk_index, content, token_count, char_start, char_end,
      embedding, embedding_model
    ) values (
      '00000000-0000-0000-0000-0000000000d1', 1, 'sneaky', 1, 0, 5,
      array_fill(0.01, array[1536])::extensions.vector, 'test-model'
    )$t$,
  '42501',
  null,
  'user B cannot attach a chunk to user A''s document'
);

select is(
  (select count(*) from public.match_document_chunks(
    array_fill(0.01, array[1536])::extensions.vector, 'hello'
  )),
  0::bigint,
  'user B''s hybrid retrieval returns none of user A''s chunks'
);

select throws_ok(
  $t$insert into public.messages (conversation_id, role, content)
    values ('00000000-0000-0000-0000-00000000c0d1', 'user', 'sneaky message')$t$,
  '42501',
  null,
  'user B cannot insert a message into user A''s conversation'
);

select is(
  (select count(*) from public.conversations where id = '00000000-0000-0000-0000-00000000c0d1'),
  0::bigint,
  'user B cannot see user A''s conversation'
);

select * from finish();
rollback;
