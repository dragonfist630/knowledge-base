-- Re-audit pass (D9.11): close the retrieval TOCTOU race noted (and
-- deliberately left open) in docs/DECISIONS.md D9.5. See that entry and
-- D9.11 for the full writeup.
--
-- D6.15 (20260922182426_chunk-freshness-and-keyword-floor.sql) already
-- guarantees match_document_chunks only ever returns chunks whose
-- content_hash matches documents.content_hash AT THE MOMENT THE RPC RUNS.
-- That closes the "stale chunk from an unfinished/failed reindex" case,
-- but retrieval.service.ts's packContext makes a SECOND, separate read
-- moments later — RetrievalRepository.findContentByIds, to re-slice a
-- merged block's content out of the document's then-current `content`
-- using char_start/char_end that are only valid against the content the
-- matched chunk was actually produced from. If a save (and the
-- content_hash bump documents.service.ts's update() makes synchronously,
-- well before the background reindex that would produce fresh chunks
-- even starts) lands in the narrow window between those two reads, the
-- offsets from the RPC's response no longer describe the same text in
-- the content findContentByIds just read — silently splicing the wrong
-- span in as if it were a verbatim quote, the same corruption D6.15
-- fixed for the RPC's own read, just moved one step later.
--
-- The RPC already has each matched chunk's content_hash in scope
-- internally (c.content_hash, used by D6.15's own freshness join) — it
-- just never returned it to the caller. Adding it lets the application
-- layer compare it against a fresh read's own content_hash and detect
-- exactly this race, the same way replace_document_chunks and
-- match_document_chunks itself already detect it at write/read time.

-- Postgres refuses to CREATE OR REPLACE a function whose RETURNS TABLE
-- column list changes (only the body may change in place) — this one adds
-- a column, so the old signature has to be dropped first. Same 6 input
-- arguments as before, so nothing that calls this RPC by name breaks.
drop function if exists public.match_document_chunks(extensions.vector, text, int, float, uuid[], text[]);

create function public.match_document_chunks(
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
  content_hash text,
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
    c.content_hash,
    f.similarity,
    f.text_rank,
    f.score
  from fused f
  join public.document_chunks c on c.id = f.id
  join public.documents d on d.id = c.document_id
  order by f.score desc
  limit least(match_count, 20);
$$;
