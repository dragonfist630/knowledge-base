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
  similarity: number;
  textRank: number;
  score: number;
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
      similarity: row.similarity,
      textRank: row.text_rank,
      score: row.score,
    }));
  }

  /** Full `content` for a set of documents, keyed by id — only called for documents where RetrievalService actually needs to re-slice a merged span; RLS means this can only ever return the requesting user's own documents. */
  async findContentByIds(db: SupabaseClient<Database>, documentIds: string[]): Promise<Map<string, string>> {
    if (documentIds.length === 0) return new Map();
    const { data, error } = await db.from("documents").select("id, content").in("id", documentIds);
    if (error) throw error;
    return new Map((data ?? []).map((row) => [row.id, row.content]));
  }
}
