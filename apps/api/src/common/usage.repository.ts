import { Injectable } from "@nestjs/common";
import type { Database } from "@kb/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

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
  conversationId?: string;
}

/**
 * Shared `ai_usage_events` writer for Phase 5's own AI calls (retrieval's
 * `query_rewrite`, chat's `chat` completion) — the same insert shape as
 * `IndexingRepository.recordUsage` (Phase 4), deliberately kept as its own
 * small copy here rather than factored out from IndexingRepository: Phase
 * 4's usage recording already has its own hard-won, regression-tested
 * call-order/failure-handling behavior (D4.6), and this avoids touching
 * that code for an unrelated phase. `user_id` is omitted the same way —
 * the column defaults to `auth.uid()`, resolved from this client's own JWT.
 */
@Injectable()
export class UsageRepository {
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
      conversation_id: event.conversationId ?? null,
    });
    if (error) throw error;
  }
}
