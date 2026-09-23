import { Injectable } from "@nestjs/common";
import type { Database } from "@kb/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface MatchDocumentChunksParams {
  /** pgvector text literal form, e.g. "[0.1,0.2,...]" — same convention as replace_document_chunks's own `embedding` input (see indexing.repository.ts). */
  queryEmbedding: string;
  queryText: string;
  matchCount: number;
  minSimilarity: number;
  filterDocumentIds?: string[];
  filterTags?: string[];
}

export interface MatchedChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  headingPath: string | null;
  content: string;
  charStart: number;
  charEnd: number;
  /** The document_chunks row's own content_hash — the content this chunk (and its char offsets) were actually produced from. See RetrievalService.packContext and docs/DECISIONS.md D9.11 for why the caller needs this. */
  contentHash: string;
  similarity: number;
  textRank: number;
  score: number;
}

/** A document's current `content` plus the `content_hash` it was read alongside — see RetrievalRepository.findContentByIds. */
export interface DocumentContent {
  content: string;
  contentHash: string;
}

/**
 * Thin wrapper over the `match_document_chunks` RPC (hybrid semantic +
 * keyword retrieval, fused with RRF — see supabase/migrations, Phase 1) and
 * the one extra read retrieval sometimes needs on top of it: a document's
 * full content, to reconstruct a clean, deduplicated span when
 * RetrievalService merges overlap-adjacent chunks into one source block
 * (see docs/DECISIONS.md Phase 5). Every method takes the caller's
 * request-scoped client — RLS enforces the user boundary, same as every
 * other repository in this app.
 */
@Injectable()
export class RetrievalRepository {
  async matchDocumentChunks(db: SupabaseClient<Database>, params: MatchDocumentChunksParams): Promise<MatchedChunk[]> {
    const { data, error } = await db.rpc("match_document_chunks", {
      query_embedding: params.queryEmbedding,
      query_text: params.queryText,
      match_count: params.matchCount,
      min_similarity: params.minSimilarity,
      filter_document_ids: params.filterDocumentIds ?? undefined,
      filter_tags: params.filterTags ?? undefined,
    });
    if (error) throw error;
    return (data ?? []).map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      documentTitle: row.document_title,
      chunkIndex: row.chunk_index,
      headingPath: row.heading_path,
      content: row.content,
      charStart: row.char_start,
      charEnd: row.char_end,
      contentHash: row.content_hash,
      similarity: row.similarity,
      textRank: row.text_rank,
      score: row.score,
    }));
  }

  /**
   * Full `content` for a set of documents, keyed by id, alongside each
   * one's CURRENT `content_hash` — only called for documents where
   * RetrievalService actually needs to re-slice a merged span; RLS means
   * this can only ever return the requesting user's own documents.
   *
   * The `content_hash` is what lets the caller detect the race this read
   * is exposed to: it runs moments after matchDocumentChunks's own RPC
   * call, in a separate round trip, so a save landing in that window (the
   * document's `content_hash` is bumped synchronously by
   * documents.service.ts's `update()`, well before any reindex that would
   * produce chunks matching the NEW content) means this read can return
   * content whose layout no longer matches the char offsets the matched
   * chunk was actually computed against. See RetrievalService.packContext
   * and docs/DECISIONS.md D9.11.
   */
  async findContentByIds(db: SupabaseClient<Database>, documentIds: string[]): Promise<Map<string, DocumentContent>> {
    if (documentIds.length === 0) return new Map();
    const { data, error } = await db.from("documents").select("id, content, content_hash").in("id", documentIds);
    if (error) throw error;
    return new Map((data ?? []).map((row) => [row.id, { content: row.content, contentHash: row.content_hash }]));
  }
}
