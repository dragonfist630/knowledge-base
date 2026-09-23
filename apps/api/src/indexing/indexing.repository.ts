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

export interface IndexingJobInput {
  documentId: string;
  contentHash: string;
}

/** A job row `claim_indexing_jobs` just flipped to 'processing' for this caller. */
export interface ClaimedIndexingJob {
  documentId: string;
  contentHash: string;
  attempts: number;
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
   * Durably enqueues (or replaces) the indexing job for one document — a
   * plain upsert keyed on `document_id` (the table's primary key, see the
   * migration), so a document that already has a pending/processing job
   * gets that job's content_hash/status/attempts/error reset to a fresh
   * 'pending' state rather than queuing a second row. This is what gives
   * "latest edit wins, one job per document" semantics without any extra
   * logic — the same guarantee the old in-memory queue's `pendingByDocument`
   * Map gave for free, now durable across a restart.
   */
  async enqueueJob(db: SupabaseClient<Database>, job: IndexingJobInput): Promise<void> {
    const { error } = await db.from("document_indexing_jobs").upsert(
      {
        document_id: job.documentId,
        content_hash: job.contentHash,
        status: "pending",
        locked_at: null,
        attempts: 0,
        error: null,
      },
      { onConflict: "document_id" },
    );
    if (error) throw error;
  }

  /**
   * Atomically claims up to `limit` of the CALLING USER's own pending (or
   * stale-processing) jobs via the `claim_indexing_jobs` RPC — see that
   * function's own comment in the migration for the `for update skip
   * locked` mechanics. RLS means this can only ever return rows this
   * caller's own JWT is entitled to see, same as every other method here.
   */
  async claimJobs(db: SupabaseClient<Database>, limit: number, staleAfterSeconds: number): Promise<ClaimedIndexingJob[]> {
    const { data, error } = await db.rpc("claim_indexing_jobs", {
      p_limit: limit,
      p_stale_after: `${staleAfterSeconds} seconds`,
    });
    if (error) throw error;
    return (data ?? []).map((row) => ({ documentId: row.document_id, contentHash: row.content_hash, attempts: row.attempts }));
  }

  /**
   * Deletes a job row on successful completion — guarded by `content_hash`
   * so a job that finishes processing an OLD version of the document,
   * after a newer edit already upserted a fresh 'pending' row for the new
   * content_hash, can't delete that newer job out from under it. A 0-row
   * delete here is a silent, expected no-op in exactly that race, mirroring
   * `replace_document_chunks`'s own content_hash guard.
   */
  async completeJob(db: SupabaseClient<Database>, documentId: string, contentHash: string): Promise<void> {
    const { error } = await db
      .from("document_indexing_jobs")
      .delete()
      .eq("document_id", documentId)
      .eq("content_hash", contentHash);
    if (error) throw error;
  }

  /**
   * Records a failed attempt — same `content_hash` guard as `completeJob`,
   * for the same reason: a stale failure for a since-superseded content
   * version must not stomp the fresh 'pending' row a newer edit already
   * created.
   */
  async failJob(db: SupabaseClient<Database>, documentId: string, contentHash: string, message: string): Promise<void> {
    const { error } = await db
      .from("document_indexing_jobs")
      .update({ status: "failed", error: message })
      .eq("document_id", documentId)
      .eq("content_hash", contentHash);
    if (error) throw error;
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
