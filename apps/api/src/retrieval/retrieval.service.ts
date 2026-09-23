import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ChatModel, EmbeddingModel } from "@kb/ai";
import { countTokens, stripCitationMarkers } from "@kb/rag-core";
import type { HistoryTurn } from "@kb/rag-core";
import type { Database } from "@kb/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

import { API_ENV } from "../config/config.module.js";
import type { ApiEnv } from "../config/env.js";
import { CHAT_MODEL, EMBEDDING_MODEL } from "../ai/ai.module.js";
// UsageRepository and RetrievalRepository must stay value imports
// (constructor-injected) — see docs/DECISIONS.md Phase 3, D3.3.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsageRepository } from "../common/usage.repository.js";
import type { MatchedChunk } from "./retrieval.repository.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { RetrievalRepository } from "./retrieval.repository.js";

/** One retrieved (and possibly overlap-merged) source block, ready to feed PromptBuilder — matches the brief's Phase 5 `Source` shape exactly. */
export interface Source {
  sourceId: string;
  chunkIds: string[];
  documentId: string;
  documentTitle: string;
  headingPath: string | null;
  content: string;
  charStart: number;
  charEnd: number;
  similarity: number;
  score: number;
}

export interface RetrieveParams {
  question: string;
  /** Oldest-first, as stored — only used to decide whether to rewrite and, when rewriting, to resolve pronouns/references. */
  history: HistoryTurn[];
  documentIds?: string[];
  tags?: string[];
}

export interface RetrieveResult {
  sources: Source[];
  /** The query text retrieval actually used — equals `question` whenever no rewrite ran or it fell back. */
  rewrittenQuery: string;
  usedRewrite: boolean;
}

/** Only the last few turns go into the (deliberately "cheap") rewrite call — a long conversation shouldn't make every turn's rewrite call slow or expensive. */
const REWRITE_HISTORY_TURNS = 6;

const QUERY_REWRITE_SYSTEM_PROMPT =
  "Rewrite the user's latest message into one standalone search query for a document search engine. " +
  "Resolve pronouns and implicit references using the conversation history. Don't answer the question. " +
  "Output only the rewritten query — no explanation, no quotes, no extra text.";

interface MergedBlock {
  documentId: string;
  documentTitle: string;
  headingPath: string | null;
  minChunkIndex: number;
  maxChunkIndex: number;
  chunkIds: string[];
  content: string;
  charStart: number;
  charEnd: number;
  /** All chunks matched for one document in a single RPC call always share one content_hash — replace_document_chunks always stamps a full delete+reinsert per document with the same p_content_hash, never a partial update — so this is just the first chunk's own value, same as `content`/`headingPath` before any merge-time update. See packContext for what it's used for. */
  contentHash: string;
  similarity: number;
  score: number;
}

/**
 * Retrieval service (Phase 5): optional query rewrite -> embed -> hybrid
 * RPC match -> near-duplicate merge -> token-budgeted context packing. See
 * docs/DECISIONS.md Phase 5 for the full design writeup (why merging is
 * offset-based rather than text-diffing, why the rewrite call is capped to
 * the last few turns, why min-similarity/top-k/context-budget live in env).
 */
@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(CHAT_MODEL) private readonly chatModel: ChatModel,
    @Inject(EMBEDDING_MODEL) private readonly embeddingModel: EmbeddingModel,
    private readonly repository: RetrievalRepository,
    private readonly usageRepository: UsageRepository,
  ) {}

  async retrieve(db: SupabaseClient<Database>, params: RetrieveParams, conversationId: string): Promise<RetrieveResult> {
    const { query, usedRewrite } = await this.maybeRewriteQuery(db, params, conversationId);

    const { vectors } = await this.embeddingModel.embed([query]);
    const vector = vectors[0] ?? [];
    const queryEmbedding = `[${vector.join(",")}]`;

    const rows = await this.repository.matchDocumentChunks(db, {
      queryEmbedding,
      queryText: query,
      matchCount: this.env.RAG_TOP_K,
      minSimilarity: this.env.RAG_MIN_SIMILARITY,
      filterDocumentIds: params.documentIds,
      filterTags: params.tags,
    });

    const sources = await this.packContext(db, rows);
    return { sources, rewrittenQuery: query, usedRewrite };
  }

  /**
   * Runs only when the conversation has prior turns and RAG_QUERY_REWRITE
   * isn't disabled. Any error, timeout, or empty output falls back to the
   * raw question — a broken rewrite must never block retrieval itself.
   */
  private async maybeRewriteQuery(
    db: SupabaseClient<Database>,
    params: RetrieveParams,
    conversationId: string,
  ): Promise<{ query: string; usedRewrite: boolean }> {
    if (!this.env.RAG_QUERY_REWRITE || params.history.length === 0) {
      return { query: params.question, usedRewrite: false };
    }

    const recentHistory = params.history.slice(-REWRITE_HISTORY_TURNS);
    const messages = [
      { role: "system" as const, content: QUERY_REWRITE_SYSTEM_PROMPT },
      ...recentHistory.map((turn) => ({
        role: turn.role,
        content: turn.role === "assistant" ? stripCitationMarkers(turn.content) : turn.content,
      })),
      { role: "user" as const, content: params.question },
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.env.RAG_QUERY_REWRITE_TIMEOUT_MS);
    try {
      const completion = await this.chatModel.complete(messages, { signal: controller.signal, temperature: 0 });
      const rewritten = completion.text.trim();
      if (!rewritten) {
        return { query: params.question, usedRewrite: false };
      }
      await this.recordRewriteUsageBestEffort(db, completion.usage, conversationId);
      return { query: rewritten, usedRewrite: true };
    } catch (error) {
      this.logger.warn(
        `Query rewrite failed or timed out for conversation ${conversationId}; falling back to the raw question.`,
        error instanceof Error ? error.stack : error,
      );
      return { query: params.question, usedRewrite: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Same best-effort principle as indexing's recordUsageBestEffort (D4.6): a hiccup recording cost must never turn an otherwise-successful rewrite into a failure. */
  private async recordRewriteUsageBestEffort(
    db: SupabaseClient<Database>,
    usage: { promptTokens: number; completionTokens: number; totalTokens: number; estimated: boolean },
    conversationId: string,
  ): Promise<void> {
    try {
      await this.usageRepository.recordUsage(db, {
        operation: "query_rewrite",
        provider: this.chatModel.descriptor.provider,
        model: this.chatModel.descriptor.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        isEstimated: usage.estimated,
        conversationId,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to record query_rewrite usage for conversation ${conversationId} (the rewrite itself was not affected).`,
        error instanceof Error ? error.stack : error,
      );
    }
  }

  /**
   * Merges overlap-adjacent chunks — same document, consecutive
   * chunk_index, AND matching heading_path — into one source block per
   * the brief's step 3, then applies the RAG_CONTEXT_TOKENS budget,
   * walking blocks in score order and always keeping at least the first
   * one even if it alone exceeds the budget (same "never end up with
   * nothing" principle as rag-core's history trimming). A block that
   * doesn't fit the remaining budget is skipped, not treated as the end
   * of packing — blocks are sorted by score, but a big mid-ranked block
   * shouldn't crowd out a smaller, lower-ranked one that would still fit
   * (greedy best-fit-by-score, not "stop at the first miss").
   *
   * Both conditions on the merge are load-bearing, not just consecutive
   * chunk_index: the chunker never applies overlap across a heading
   * boundary and never includes a heading line in a chunk's own content
   * (see chunker.ts), so two chunks from different sections share no
   * text at all even when index-adjacent. Merging on index alone used to
   * report the wrong (first chunk's) heading_path for the merged block
   * and splice the second chunk's heading markup — text that was never
   * part of either original chunk — into the content sent to the LLM as
   * a source (found and fixed during Phase 5 re-validation; see
   * docs/DECISIONS.md D5.10).
   */
  private async packContext(db: SupabaseClient<Database>, rows: MatchedChunk[]): Promise<Source[]> {
    const blocks = this.mergeAdjacent(rows);
    blocks.sort((a, b) => b.score - a.score);

    // Only merged blocks (more than one chunk) need a fresh, deduplicated
    // slice of the full document — a single-chunk block's `content` is
    // already exactly document_chunks.content, no extra read needed.
    const needsRefetch = blocks.filter((b) => b.chunkIds.length > 1).map((b) => b.documentId);
    const documentContents = await this.repository.findContentByIds(db, [...new Set(needsRefetch)]);
    for (const block of blocks) {
      if (block.chunkIds.length <= 1) continue;
      const fresh = documentContents.get(block.documentId);
      // Re-slice only when this read's content_hash still matches the one
      // the matched chunk (and its char offsets) were actually computed
      // from. Without this check, a save landing between matchDocumentChunks's
      // RPC call and this read — content_hash is bumped synchronously by
      // documents.service.ts's update(), well before the background
      // reindex that would produce chunks matching the new content even
      // starts — would silently splice the WRONG span of the new content
      // in, using offsets that described a completely different layout,
      // and present it to the LLM (and the user, via citations) as a
      // verbatim quote. Falling back to whatever content the merge step
      // already accumulated (the first chunk's own, un-re-sliced content —
      // stale/incomplete for a multi-chunk block, but never corrupted) is
      // the same "don't take down the whole turn" fallback this code
      // already used for a document that vanished outright — a hash
      // mismatch gets the identical treatment, not a special case. See
      // docs/DECISIONS.md D9.11; D6.15 covers the analogous race one level
      // up, in matchDocumentChunks's own RPC read.
      if (fresh !== undefined && fresh.contentHash === block.contentHash) {
        block.content = fresh.content.slice(block.charStart, block.charEnd);
      }
    }

    const sources: Source[] = [];
    let usedTokens = 0;
    for (const block of blocks) {
      const tokens = countTokens(block.content);
      if (sources.length > 0 && usedTokens + tokens > this.env.RAG_CONTEXT_TOKENS) continue;
      usedTokens += tokens;
      sources.push({
        sourceId: `S${sources.length + 1}`,
        chunkIds: block.chunkIds,
        documentId: block.documentId,
        documentTitle: block.documentTitle,
        headingPath: block.headingPath,
        content: block.content,
        charStart: block.charStart,
        charEnd: block.charEnd,
        similarity: block.similarity,
        score: block.score,
      });
    }
    return sources;
  }

  private mergeAdjacent(rows: MatchedChunk[]): MergedBlock[] {
    const byDocument = new Map<string, MatchedChunk[]>();
    for (const row of rows) {
      const list = byDocument.get(row.documentId);
      if (list) {
        list.push(row);
      } else {
        byDocument.set(row.documentId, [row]);
      }
    }

    const blocks: MergedBlock[] = [];
    for (const docRows of byDocument.values()) {
      const sorted = [...docRows].sort((a, b) => a.chunkIndex - b.chunkIndex);
      let current: MergedBlock | null = null;
      for (const row of sorted) {
        if (current && row.chunkIndex === current.maxChunkIndex + 1 && row.headingPath === current.headingPath) {
          current.maxChunkIndex = row.chunkIndex;
          current.chunkIds.push(row.chunkId);
          current.charStart = Math.min(current.charStart, row.charStart);
          current.charEnd = Math.max(current.charEnd, row.charEnd);
          current.similarity = Math.max(current.similarity, row.similarity);
          current.score = Math.max(current.score, row.score);
          continue;
        }
        if (current) blocks.push(current);
        current = {
          documentId: row.documentId,
          documentTitle: row.documentTitle,
          headingPath: row.headingPath,
          minChunkIndex: row.chunkIndex,
          maxChunkIndex: row.chunkIndex,
          chunkIds: [row.chunkId],
          content: row.content,
          charStart: row.charStart,
          charEnd: row.charEnd,
          contentHash: row.contentHash,
          similarity: row.similarity,
          score: row.score,
        };
      }
      if (current) blocks.push(current);
    }
    return blocks;
  }
}
