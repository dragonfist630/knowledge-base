import { Injectable } from "@nestjs/common";
import type { Database, Json } from "@kb/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface DocumentForIndexing {
  id: string;
  title: string;
  content: string;
  contentHash: string;
}

/**
 * One chunk record shaped exactly as `replace_document_chunks`'s
 * `jsonb_to_recordset(p_chunks)` call expects — snake_case, and `embedding`
 * as the pgvector text literal form (`"[0.1,0.2,...]"`), which the RPC
 * itself casts with `::extensions.vector`. See supabase/migrations/*_init.sql.
 */
export interface RpcChunkInput {
  chunk_index: number;
  content: string;
  heading_path: string | null;
  token_count: number;
  char_start: number;
  char_end: number;
  embedding: string;
}

export interface UsageEventInput {
  operation: "embedding" | "chat" | "query_rewrite";
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  isEstimated: boolean;
  latencyMs?: number;
  documentId?: string;
}

/**
 * Thin wrapper over the Supabase client for the indexing pipeline — same
 * "no business logic here" split as documents.repository.ts. Every method
 * takes the job's own request-scoped client (built from the JWT captured
 * when the job was enqueued), so every query runs under RLS as that user,
 * same as the rest of apps/api — there is still no service-role client
 * anywhere in this app.
 */
@Injectable()
export class IndexingRepository {
  async findForIndexing(db: SupabaseClient<Database>, id: string): Promise<DocumentForIndexing | null> {
    const { data, error } = await db.from("documents").select("id, title, content, content_hash").eq("id", id).maybeSingle();
    if (error) throw error;
    return data ? { id: data.id, title: data.title, content: data.content, contentHash: data.content_hash } : null;
  }

  /**
   * Wraps the `replace_document_chunks` RPC. Returns `false` (not an
   * exception) exactly when the RPC itself skipped the write because a
   * newer save has already changed the document's content_hash out from
   * under this job — see the RPC body and D4.x in docs/DECISIONS.md. The
   * caller MUST treat `false` as "silently skip", not as a failure.
   */
  async replaceChunks(
    db: SupabaseClient<Database>,
    params: { documentId: string; contentHash: string; embeddingModel: string; chunks: RpcChunkInput[] },
  ): Promise<boolean> {
    const { data, error } = await db.rpc("replace_document_chunks", {
      p_document_id: params.documentId,
      p_content_hash: params.contentHash,
      p_embedding_model: params.embeddingModel,
      // RpcChunkInput is a closed TS interface (no index signature), so it
      // doesn't structurally satisfy `Json` even though every value it can
      // ever hold — strings, numbers, null — is plain, valid JSON. Safe to
      // assert through `unknown` rather than widen the interface itself.
      p_chunks: params.chunks as unknown as Json,
    });
    if (error) throw error;
    return data === true;
  }

  /**
   * Flips a document to 'indexing' right before processing starts, so its
   * status is visible (via GET /documents/:id) as "actively being worked
   * on" rather than just "queued" the whole time — also what lets the
   * crash-recovery sweep (documents.service.ts's resumeStuckIndexing)
   * distinguish "was mid-flight when the process died" from "never even
   * started". Guarded by content_hash, same principle as `markFailed`: a
   * stale job for an already-superseded version of the document is a
   * silent no-op here too.
   */
  async markIndexing(db: SupabaseClient<Database>, documentId: string, contentHash: string): Promise<void> {
    const { error } = await db
      .from("documents")
      .update({ index_status: "indexing" })
      .eq("id", documentId)
      .eq("content_hash", contentHash);
    if (error) throw error;
  }

  /**
   * Records a failed indexing attempt. Guarded by `content_hash` the same
   * way `replace_document_chunks` guards its own write: if a newer save has
   * already changed the hash (and, in the process, re-enqueued its own
   * fresh 'pending' job), this failure belongs to a superseded version of
   * the document and must not stomp on that newer job's state. A stale
   * failure simply matches zero rows and is a silent no-op, same principle
   * as the RPC's own `false` return.
   */
  async markFailed(db: SupabaseClient<Database>, documentId: string, contentHash: string, message: string): Promise<void> {
    const { error } = await db
      .from("documents")
      .update({ index_status: "failed", index_error: message })
      .eq("id", documentId)
      .eq("content_hash", contentHash);
    if (error) throw error;
  }

  /** `user_id` is deliberately omitted — the column defaults to `auth.uid()`, resolved from this client's own JWT, same pattern as documents.repository.ts's `insert`. */
  async recordUsage(db: SupabaseClient<Database>, event: UsageEventInput): Promise<void> {
    const { error } = await db.from("ai_usage_events").insert({
      operation: event.operation,
      provider: event.provider,
      model: event.model,
      prompt_tokens: event.promptTokens,
      completion_tokens: event.completionTokens,
      total_tokens: event.totalTokens,
      is_estimated: event.isEstimated,
      latency_ms: event.latencyMs ?? null,
      document_id: event.documentId ?? null,
    });
    if (error) throw error;
  }
}
