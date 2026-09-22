-- Phase 6 audit (D6.15): close a retrieval-correctness gap found in a full-
-- application review. See docs/DECISIONS.md Phase 6, D6.15 for the full
-- writeup, including a second suspected issue that was investigated and
-- specifically NOT changed here (see that entry for why).
--
-- document_chunks had no record of which version of a document's content it
-- was chunked from. documents.content_hash is updated to the NEW hash the
-- instant an edit is saved (documents.service.ts), before the background
-- indexing job that produces new chunks has even started — so the instant a
-- document is edited, saved, and its embed call is still in flight (or
-- fails outright), match_document_chunks keeps returning the PREVIOUS
-- version's chunks with no indication they're stale, and
-- retrieval.service.ts's packContext re-slices merged blocks out of the
-- CURRENT documents.content using char offsets that belong to the OLD
-- content — silently returning corrupted (not just outdated) text as if it
-- were a verbatim quote.

-- document_chunks now carries the content_hash it was chunked from ---------

alter table public.document_chunks add column content_hash text;

update public.document_chunks c
set content_hash = d.content_hash
from public.documents d
where d.id = c.document_id;

alter table public.document_chunks alter column content_hash set not null;

-- replace_document_chunks: stamp every new chunk with the hash it was
-- computed from (already passed in as p_content_hash and already used to
-- guard the write itself — this just also persists it per-row). ----------

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
    token_count, char_start, char_end, embedding, embedding_model, content_hash
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
    p_embedding_model,
    p_content_hash
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

-- match_document_chunks: only chunks whose content_hash matches the
-- document's CURRENT content_hash are eligible — the same freshness
-- guarantee replace_document_chunks already enforces at write time, applied
-- at read time too. The new predicate is applied in the same place
-- filter_tags already is (the `semantic`/`keyword` CTEs, after the ANN/GIN
-- top-K fetch) — joining documents any earlier defeats the HNSW index, per
-- the planner note already in this file. Same 6-argument signature as
-- before, so this replaces the function in place rather than creating a
-- second overload. -----------------------------------------------------

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
  with semantic_raw as (
    select
      c.id,
      c.document_id,
      c.content_hash,
      1 - (c.embedding <=> query_embedding) as similarity
    from public.document_chunks c
    where c.user_id = (select auth.uid())
      and (filter_document_ids is null or c.document_id = any(filter_document_ids))
    order by c.embedding <=> query_embedding
    limit match_count * 8
  ),
  semantic as (
    select
      sr.id,
      sr.similarity,
      row_number() over (order by sr.similarity desc) as rank
    from semantic_raw sr
    join public.documents d on d.id = sr.document_id
    where (filter_tags is null or d.tags && filter_tags)
      and sr.content_hash = d.content_hash
    order by sr.similarity desc
    limit match_count * 4
  ),
  keyword_raw as (
    select
      c.id,
      c.document_id,
      c.content_hash,
      ts_rank_cd(c.fts, websearch_to_tsquery('english', query_text)) as text_rank
    from public.document_chunks c
    where c.user_id = (select auth.uid())
      and (filter_document_ids is null or c.document_id = any(filter_document_ids))
      and c.fts @@ websearch_to_tsquery('english', query_text)
    order by text_rank desc
    limit match_count * 8
  ),
  keyword as (
    select
      kr.id,
      kr.text_rank,
      row_number() over (order by kr.text_rank desc) as rank
    from keyword_raw kr
    join public.documents d on d.id = kr.document_id
    where (filter_tags is null or d.tags && filter_tags)
      and kr.content_hash = d.content_hash
    order by kr.text_rank desc
    limit match_count * 4
  ),
  fused as (
    select
      coalesce(sem.id, kw.id) as id,
      coalesce(sem.similarity, 0) as similarity,
      coalesce(kw.text_rank, 0) as text_rank,
      coalesce(1.0 / (60 + sem.rank), 0) + coalesce(1.0 / (60 + kw.rank), 0) as score
    from semantic sem
    full outer join keyword kw on kw.id = sem.id
    where coalesce(sem.similarity, 0) >= min_similarity or kw.id is not null
  )
  select
    c.id as chunk_id,
    c.document_id,
    d.title as document_title,
    c.chunk_index,
    c.heading_path,
    c.content,
    c.char_start,
    c.char_end,
    f.similarity,
    f.text_rank,
    f.score
  from fused f
  join public.document_chunks c on c.id = f.id
  join public.documents d on d.id = c.document_id
  order by f.score desc
  limit least(match_count, 20);
$$;
