-- Phase 1: core schema, RLS, and retrieval RPCs.
-- See docs/DECISIONS.md for notes on any deviations from the brief.

create extension if not exists vector with schema extensions;

-- authenticated/anon need USAGE on this schema to reference extensions.vector
-- in RPC signatures and casts (create extension alone doesn't grant it).
grant usage on schema extensions to postgres, anon, authenticated, service_role;

create type public.index_status as enum ('pending', 'indexing', 'ready', 'failed');

-- documents ------------------------------------------------------------

create table public.documents (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title         text not null check (char_length(btrim(title)) between 1 and 200),
  content       text not null default '' check (char_length(content) <= 500000),
  tags          text[] not null default '{}' check (cardinality(tags) <= 20),
  content_hash  text not null,
  source_type   text not null default 'manual' check (source_type in ('manual','upload')),
  source_name   text,
  index_status  public.index_status not null default 'pending',
  index_error   text,
  chunk_count   int not null default 0,
  indexed_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index documents_user_updated_idx on public.documents (user_id, updated_at desc);
create index documents_tags_gin on public.documents using gin (tags);

-- document_chunks --------------------------------------------------------

create table public.document_chunks (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references public.documents(id) on delete cascade,
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  chunk_index     int  not null check (chunk_index >= 0),
  content         text not null check (char_length(btrim(content)) > 0),
  heading_path    text,
  token_count     int  not null,
  char_start      int  not null,
  char_end        int  not null,
  embedding       extensions.vector(1536) not null,
  embedding_model text not null,
  fts tsvector generated always as (to_tsvector('english', coalesce(heading_path,'') || ' ' || content)) stored,
  created_at      timestamptz not null default now(),
  unique (document_id, chunk_index)
);

create index document_chunks_user_idx on public.document_chunks (user_id);
create index document_chunks_embedding_hnsw on public.document_chunks
  using hnsw (embedding extensions.vector_cosine_ops) with (m = 16, ef_construction = 64);
create index document_chunks_fts_gin on public.document_chunks using gin (fts);

-- conversations / messages ------------------------------------------------

create table public.conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title      text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversations_user_updated_idx on public.conversations (user_id, updated_at desc);

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  role            text not null check (role in ('user','assistant')),
  content         text not null default '',
  status          text not null default 'complete' check (status in ('streaming','complete','aborted','error')),
  citations       jsonb not null default '[]',
  retrieval       jsonb,
  model           text,
  created_at      timestamptz not null default now()
);

create index messages_conversation_created_idx on public.messages (conversation_id, created_at);
create index messages_user_idx on public.messages (user_id);

-- ai_usage_events ----------------------------------------------------------

create table public.ai_usage_events (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  operation         text not null check (operation in ('chat','embedding','query_rewrite')),
  provider          text not null,
  model             text not null,
  prompt_tokens     int not null default 0,
  completion_tokens int not null default 0,
  total_tokens      int not null default 0,
  is_estimated      boolean not null default false,
  latency_ms        int,
  conversation_id   uuid references public.conversations(id) on delete set null,
  document_id       uuid references public.documents(id) on delete set null,
  created_at        timestamptz not null default now()
);

create index ai_usage_user_created_idx on public.ai_usage_events (user_id, created_at desc);

-- updated_at trigger --------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

-- RLS ------------------------------------------------------------------

alter table public.documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.ai_usage_events enable row level security;

create policy documents_select on public.documents for select to authenticated
  using ((select auth.uid()) = user_id);
create policy documents_insert on public.documents for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy documents_update on public.documents for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy documents_delete on public.documents for delete to authenticated
  using ((select auth.uid()) = user_id);

-- document_chunks: no update policy — chunks are replaced, never edited.
create policy document_chunks_select on public.document_chunks for select to authenticated
  using ((select auth.uid()) = user_id);
create policy document_chunks_insert on public.document_chunks for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.documents d
      where d.id = document_id and d.user_id = (select auth.uid())
    )
  );
create policy document_chunks_delete on public.document_chunks for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy conversations_select on public.conversations for select to authenticated
  using ((select auth.uid()) = user_id);
create policy conversations_insert on public.conversations for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy conversations_update on public.conversations for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy conversations_delete on public.conversations for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy messages_select on public.messages for select to authenticated
  using ((select auth.uid()) = user_id);
create policy messages_insert on public.messages for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = (select auth.uid())
    )
  );
create policy messages_update on public.messages for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy messages_delete on public.messages for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ai_usage_events: select + insert only.
create policy ai_usage_events_select on public.ai_usage_events for select to authenticated
  using ((select auth.uid()) = user_id);
create policy ai_usage_events_insert on public.ai_usage_events for insert to authenticated
  with check ((select auth.uid()) = user_id);

-- grants -----------------------------------------------------------------

revoke all on all tables in schema public from anon;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.documents to authenticated;
grant select, insert, delete on public.document_chunks to authenticated;
grant select, insert, update, delete on public.conversations to authenticated;
grant select, insert, update, delete on public.messages to authenticated;
grant select, insert on public.ai_usage_events to authenticated;

-- RPC 1: hybrid retrieval (semantic + keyword, reciprocal rank fusion) -------

create or replace function public.match_document_chunks(
  query_embedding extensions.vector(1536),
  query_text      text,
  match_count     int default 8,
  min_similarity  float default 0.25,
  filter_document_ids uuid[] default null,
  filter_tags     text[] default null
) returns table (
  chunk_id uuid,
  document_id uuid,
  document_title text,
  chunk_index int,
  heading_path text,
  content text,
  char_start int,
  char_end int,
  similarity float,
  text_rank float,
  score float
)
language sql
security invoker
stable
set search_path = public, extensions
as $$
  with scoped as (
    select c.*, d.title as document_title
    from public.document_chunks c
    join public.documents d on d.id = c.document_id
    where c.user_id = (select auth.uid())
      and (filter_document_ids is null or c.document_id = any(filter_document_ids))
      and (filter_tags is null or d.tags && filter_tags)
  ),
  semantic as (
    select
      s.id,
      1 - (s.embedding <=> query_embedding) as similarity,
      row_number() over (order by s.embedding <=> query_embedding) as rank
    from scoped s
    order by s.embedding <=> query_embedding
    limit match_count * 4
  ),
  keyword as (
    select
      s.id,
      ts_rank_cd(s.fts, websearch_to_tsquery('english', query_text)) as text_rank,
      row_number() over (
        order by ts_rank_cd(s.fts, websearch_to_tsquery('english', query_text)) desc
      ) as rank
    from scoped s
    where s.fts @@ websearch_to_tsquery('english', query_text)
    order by text_rank desc
    limit match_count * 4
  )
  select
    s.id as chunk_id,
    s.document_id,
    s.document_title,
    s.chunk_index,
    s.heading_path,
    s.content,
    s.char_start,
    s.char_end,
    coalesce(sem.similarity, 0) as similarity,
    coalesce(kw.text_rank, 0) as text_rank,
    coalesce(1.0 / (60 + sem.rank), 0) + coalesce(1.0 / (60 + kw.rank), 0) as score
  from scoped s
  left join semantic sem on sem.id = s.id
  left join keyword kw on kw.id = s.id
  where (sem.id is not null or kw.id is not null)
    and (coalesce(sem.similarity, 0) >= min_similarity or kw.id is not null)
  order by score desc
  limit least(match_count, 20);
$$;

revoke execute on function public.match_document_chunks from public, anon;
grant execute on function public.match_document_chunks to authenticated;

-- Note: pgvector >= 0.8 supports HNSW iterative scan for filtered ANN
-- queries (hnsw.iterative_scan), which avoids under-returning results when
-- filter_document_ids/filter_tags narrow the candidate set heavily. Once the
-- local/hosted Postgres is confirmed on a pgvector build that ships it
-- (select extversion from pg_extension where extname = 'vector'), enable it
-- with `set local hnsw.iterative_scan = relaxed_order;` inside this
-- function — left out for now rather than guessing the installed version,
-- per docs/DECISIONS.md.

-- RPC 2: atomic chunk replacement with a stale-write guard -------------------

create or replace function public.replace_document_chunks(
  p_document_id uuid,
  p_content_hash text,
  p_embedding_model text,
  p_chunks jsonb
) returns boolean
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_current_hash text;
  v_chunk_count int;
begin
  select content_hash into v_current_hash
  from public.documents
  where id = p_document_id
  for update;

  if not found then
    raise exception 'document % not found', p_document_id using errcode = 'P0002';
  end if;

  if v_current_hash is distinct from p_content_hash then
    -- A newer save started indexing after this one began; skip so we don't
    -- clobber fresher chunks with stale ones.
    return false;
  end if;

  delete from public.document_chunks where document_id = p_document_id;

  insert into public.document_chunks (
    document_id, user_id, chunk_index, content, heading_path,
    token_count, char_start, char_end, embedding, embedding_model
  )
  select
    p_document_id,
    (select auth.uid()),
    r.chunk_index,
    r.content,
    r.heading_path,
    r.token_count,
    r.char_start,
    r.char_end,
    r.embedding::extensions.vector,
    p_embedding_model
  from jsonb_to_recordset(p_chunks) as r(
    chunk_index int,
    content text,
    heading_path text,
    token_count int,
    char_start int,
    char_end int,
    embedding text
  );

  get diagnostics v_chunk_count = row_count;

  update public.documents
  set index_status = 'ready',
      chunk_count = v_chunk_count,
      indexed_at = now(),
      index_error = null
  where id = p_document_id;

  return true;
end;
$$;

revoke execute on function public.replace_document_chunks from public, anon;
grant execute on function public.replace_document_chunks to authenticated;

-- RPC 3 (optional): usage summary for the usage page -------------------------

create or replace function public.usage_summary(p_from timestamptz)
returns table (
  day date,
  operation text,
  model text,
  prompt_tokens bigint,
  completion_tokens bigint,
  total_tokens bigint,
  event_count bigint
)
language sql
security invoker
stable
set search_path = public, extensions
as $$
  select
    date_trunc('day', created_at)::date as day,
    operation,
    model,
    sum(prompt_tokens) as prompt_tokens,
    sum(completion_tokens) as completion_tokens,
    sum(total_tokens) as total_tokens,
    count(*) as event_count
  from public.ai_usage_events
  where user_id = (select auth.uid())
    and created_at >= p_from
  group by 1, 2, 3
  order by 1 desc, 2, 3;
$$;

revoke execute on function public.usage_summary from public, anon;
grant execute on function public.usage_summary to authenticated;
