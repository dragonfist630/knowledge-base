import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { ChatModel, FinishReason } from "@kb/ai";
import { isAiError } from "@kb/ai";
import { buildChatMessages, createCitationStreamParser } from "@kb/rag-core";
import type { HistoryTurn, PromptSource } from "@kb/rag-core";
import type {
  ChatEvent,
  ChatFinishReason,
  CitationSnapshot,
  ConversationDetail,
  ConversationListQuery,
  ConversationListResponse,
  ConversationSummary,
  Message,
  MessageStatus,
  RetrievalDebug,
  SourceSummary,
  TokenUsage,
} from "@kb/shared";
import type { Database } from "@kb/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

import { API_ENV } from "../config/config.module.js";
import type { ApiEnv } from "../config/env.js";
import { CHAT_MODEL } from "../ai/ai.module.js";
// UsageRepository, RetrievalService, and ConversationsRepository must stay
// value imports (constructor-injected) — see docs/DECISIONS.md Phase 3, D3.3.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsageRepository } from "../common/usage.repository.js";
import type { Source } from "../retrieval/retrieval.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { RetrievalService } from "../retrieval/retrieval.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ConversationsRepository } from "./conversations.repository.js";

export interface ChatTurnParams {
  conversationId?: string;
  message: string;
  documentIds?: string[];
  tags?: string[];
}

export interface ChatTurnResult {
  conversationId: string;
  userMessage: Message;
  assistantMessage: Message;
  sources: SourceSummary[];
}

export type ChatEventHandler = (event: ChatEvent) => void;

export interface RunTurnOptions {
  /** Called for every event the turn produces, in order — the SSE controller writes each one to the wire; the non-streaming controller just ignores it (the "collector" the brief describes) and reads the final ChatTurnResult instead. */
  onEvent?: ChatEventHandler;
  /** Propagated to ChatModel.stream() — aborting stops mid-generation; the model's own stream is contractually required to still end with exactly one `finish` part (finishReason: 'aborted') rather than throwing, so aborting is a normal, not an error, path here. */
  signal?: AbortSignal;
}

/** The brief's exact fixed message for the no-sources path — no chat usage event is ever recorded here since no LLM call is made. */
const NO_CONTEXT_MESSAGE = "I couldn't find this in your documents. Try rephrasing, or check the document finished indexing";

const NO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: false };

/** @kb/ai's FinishReason has a fourth value ("other") the SSE contract doesn't carry — mapped to "stop" as the safe default (see docs/DECISIONS.md Phase 5). */
function toChatFinishReason(reason: FinishReason): ChatFinishReason {
  return reason === "other" ? "stop" : reason;
}

function toSourceSummary(source: Source): SourceSummary {
  return {
    sourceId: source.sourceId,
    documentId: source.documentId,
    documentTitle: source.documentTitle,
    headingPath: source.headingPath,
    similarity: source.similarity,
    score: source.score,
  };
}

const SNIPPET_MAX = 300;

/**
 * Chat service (Phase 5): the one place that drives a full turn — get/
 * create the conversation, retrieval, prompt, stream, citation resolution,
 * persistence, usage. `runTurn` is transport-agnostic on purpose (see
 * `RunTurnOptions.onEvent`): POST /chat/stream's controller wires it
 * straight to SSE writes, POST /chat (the brief's "non-streaming
 * equivalent") calls it with no `onEvent` at all and just reads the
 * returned `ChatTurnResult` — the exact same orchestration either way, so
 * there's only one place this logic can drift from itself.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(CHAT_MODEL) private readonly chatModel: ChatModel,
    private readonly repository: ConversationsRepository,
    private readonly retrievalService: RetrievalService,
    private readonly usageRepository: UsageRepository,
  ) {}

  async runTurn(db: SupabaseClient<Database>, params: ChatTurnParams, options: RunTurnOptions = {}): Promise<ChatTurnResult> {
    const emit = options.onEvent ?? ((): void => undefined);

    const conversation = await this.getOrCreateConversation(db, params);
    const history = await this.loadHistory(db, conversation.id);

    const userMessage = await this.repository.insertUserMessage(db, conversation.id, params.message);
    const assistantPlaceholder = await this.repository.insertAssistantPlaceholder(db, conversation.id);

    emit({
      type: "start",
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      assistantMessageId: assistantPlaceholder.id,
    });

    let retrieval;
    try {
      retrieval = await this.retrievalService.retrieve(
        db,
        { question: params.message, history, documentIds: params.documentIds, tags: params.tags },
        conversation.id,
      );
    } catch (error) {
      const assistantMessage = await this.persistError(db, conversation.id, assistantPlaceholder.id, "", [], null, error, emit);
      return { conversationId: conversation.id, userMessage, assistantMessage, sources: [] };
    }

    const sourceSummaries = retrieval.sources.map(toSourceSummary);
    emit({ type: "sources", sources: sourceSummaries });

    if (retrieval.sources.length === 0) {
      const assistantMessage = await this.finishNoContext(db, conversation, assistantPlaceholder.id, retrieval, emit);
      return { conversationId: conversation.id, userMessage, assistantMessage, sources: sourceSummaries };
    }

    const assistantMessage = await this.streamAnswer(
      db,
      conversation,
      assistantPlaceholder.id,
      retrieval,
      history,
      params.message,
      emit,
      options.signal,
    );
    return { conversationId: conversation.id, userMessage, assistantMessage, sources: sourceSummaries };
  }

  private async getOrCreateConversation(db: SupabaseClient<Database>, params: ChatTurnParams): Promise<ConversationSummary> {
    if (params.conversationId) {
      const existing = await this.repository.findById(db, params.conversationId);
      if (!existing) {
        throw new NotFoundException("Conversation not found.");
      }
      return existing;
    }
    const title = params.message.trim().slice(0, 60) || "New conversation";
    return this.repository.create(db, title);
  }

  async listConversations(db: SupabaseClient<Database>, query: ConversationListQuery): Promise<ConversationListResponse> {
    return this.repository.list(db, query);
  }

  async getConversation(db: SupabaseClient<Database>, id: string): Promise<ConversationDetail> {
    const conversation = await this.repository.findById(db, id);
    if (!conversation) {
      throw new NotFoundException("Conversation not found.");
    }
    const messages = await this.repository.listMessages(db, id);
    return { ...conversation, messages };
  }

  async renameConversation(db: SupabaseClient<Database>, id: string, title: string): Promise<ConversationSummary> {
    const renamed = await this.repository.rename(db, id, title);
    if (!renamed) {
      throw new NotFoundException("Conversation not found.");
    }
    return renamed;
  }

  async deleteConversation(db: SupabaseClient<Database>, id: string): Promise<void> {
    const deleted = await this.repository.delete(db, id);
    if (!deleted) {
      throw new NotFoundException("Conversation not found.");
    }
  }

  /**
   * Oldest-first prior turns, as HistoryTurn[] for both the rewrite call
   * and the prompt. Only 'complete' and 'aborted' assistant turns are
   * reused as context — 'error' turns have empty content and contribute
   * nothing, and a leftover 'streaming' row (a process that crashed
   * mid-turn) is, by definition, not a finished thought to reuse.
   */
  private async loadHistory(db: SupabaseClient<Database>, conversationId: string): Promise<HistoryTurn[]> {
    const prior = await this.repository.listMessages(db, conversationId);
    return prior
      .filter((m) => m.role === "user" || m.status === "complete" || m.status === "aborted")
      .map((m) => ({ role: m.role, content: m.content }));
  }

  private async finishNoContext(
    db: SupabaseClient<Database>,
    conversation: ConversationSummary,
    assistantMessageId: string,
    retrieval: { rewrittenQuery: string; usedRewrite: boolean },
    emit: ChatEventHandler,
  ): Promise<Message> {
    emit({ type: "delta", text: NO_CONTEXT_MESSAGE });
    const retrievalDebug: RetrievalDebug = { rewrittenQuery: retrieval.rewrittenQuery, usedRewrite: retrieval.usedRewrite, sourceCount: 0 };
    const finalized = await this.repository.finalizeAssistantMessage(db, assistantMessageId, {
      content: NO_CONTEXT_MESSAGE,
      status: "complete",
      citations: [],
      retrieval: retrievalDebug,
      model: null,
    });
    await this.repository.touch(db, conversation.id);
    // No chat usage event — the LLM was never called for this turn (Gate 5).
    emit({ type: "done", finishReason: "stop", usage: NO_USAGE });
    return finalized;
  }

  private async streamAnswer(
    db: SupabaseClient<Database>,
    conversation: ConversationSummary,
    assistantMessageId: string,
    retrieval: { sources: Source[]; rewrittenQuery: string; usedRewrite: boolean },
    history: HistoryTurn[],
    question: string,
    emit: ChatEventHandler,
    signal: AbortSignal | undefined,
  ): Promise<Message> {
    const promptSources: PromptSource[] = retrieval.sources.map((s) => ({
      sourceId: s.sourceId,
      documentTitle: s.documentTitle,
      headingPath: s.headingPath,
      content: s.content,
    }));
    const messages = buildChatMessages(promptSources, history, question, { historyTokens: this.env.RAG_HISTORY_TOKENS });
    const citationParser = createCitationStreamParser(retrieval.sources.map((s) => s.sourceId));

    let fullText = "";
    const citedOrder: string[] = [];
    const citedSet = new Set<string>();
    let finishReason: FinishReason = "stop";
    let usage: TokenUsage = { ...NO_USAGE, estimated: true };

    try {
      for await (const part of this.chatModel.stream(messages, { signal })) {
        if (part.type === "text-delta") {
          const result = citationParser.push(part.text);
          if (result.text.length > 0) {
            fullText += result.text;
            emit({ type: "delta", text: result.text });
          }
          for (const sourceId of result.citations) {
            if (!citedSet.has(sourceId)) {
              citedSet.add(sourceId);
              citedOrder.push(sourceId);
            }
            emit({ type: "citation", sourceId });
          }
          if (result.droppedMarkers.length > 0) {
            this.logger.warn(
              `Dropped ${result.droppedMarkers.length} invalid citation marker(s) in conversation ${conversation.id}: ${result.droppedMarkers.join(", ")}`,
            );
          }
        } else {
          finishReason = part.finishReason;
          usage = part.usage;
        }
      }
      const flushed = citationParser.flush();
      if (flushed.text.length > 0) {
        fullText += flushed.text;
        emit({ type: "delta", text: flushed.text });
      }
    } catch (error) {
      const retrievalDebug: RetrievalDebug = {
        rewrittenQuery: retrieval.rewrittenQuery,
        usedRewrite: retrieval.usedRewrite,
        sourceCount: retrieval.sources.length,
      };
      const citations = this.buildCitationSnapshots(citedOrder, retrieval.sources);
      return this.persistError(db, conversation.id, assistantMessageId, fullText, citations, retrievalDebug, error, emit);
    }

    const status: MessageStatus = finishReason === "aborted" ? "aborted" : "complete";
    const citations = this.buildCitationSnapshots(citedOrder, retrieval.sources);
    const retrievalDebug: RetrievalDebug = {
      rewrittenQuery: retrieval.rewrittenQuery,
      usedRewrite: retrieval.usedRewrite,
      sourceCount: retrieval.sources.length,
    };

    const finalized = await this.repository.finalizeAssistantMessage(db, assistantMessageId, {
      content: fullText,
      status,
      citations,
      retrieval: retrievalDebug,
      model: this.chatModel.descriptor.model,
    });

    await this.recordChatUsageBestEffort(db, usage, conversation.id);
    await this.repository.touch(db, conversation.id);

    emit({ type: "done", finishReason: toChatFinishReason(finishReason), usage });
    return finalized;
  }

  private buildCitationSnapshots(citedSourceIds: string[], sources: Source[]): CitationSnapshot[] {
    const bySourceId = new Map(sources.map((s) => [s.sourceId, s]));
    const snapshots: CitationSnapshot[] = [];
    for (const sourceId of citedSourceIds) {
      const source = bySourceId.get(sourceId);
      if (!source) continue; // citationParser only ever validates against these same ids — defensive, not expected
      snapshots.push({
        sourceId: source.sourceId,
        documentId: source.documentId,
        documentTitle: source.documentTitle,
        headingPath: source.headingPath,
        snippet: source.content.length > SNIPPET_MAX ? source.content.slice(0, SNIPPET_MAX) : source.content,
        charStart: source.charStart,
        charEnd: source.charEnd,
        similarity: source.similarity,
        score: source.score,
      });
    }
    return snapshots;
  }

  /** Best-effort, same principle as indexing's recordUsageBestEffort (D4.6) and retrieval's own query_rewrite recording: a hiccup logging cost must never affect a turn that already finished successfully. */
  private async recordChatUsageBestEffort(db: SupabaseClient<Database>, usage: TokenUsage, conversationId: string): Promise<void> {
    try {
      await this.usageRepository.recordUsage(db, {
        operation: "chat",
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
        `Failed to record chat usage for conversation ${conversationId} (the answer itself was not affected).`,
        error instanceof Error ? error.stack : error,
      );
    }
  }

  private async persistError(
    db: SupabaseClient<Database>,
    conversationId: string,
    assistantMessageId: string,
    partialContent: string,
    citations: CitationSnapshot[],
    retrieval: RetrievalDebug | null,
    error: unknown,
    emit: ChatEventHandler,
  ): Promise<Message> {
    this.logger.error("Chat turn failed.", error instanceof Error ? error.stack : error);
    const message = isAiError(error) ? error.message : "Something went wrong generating a response. Try again.";
    const code = isAiError(error) ? `ai_${error.code}` : "internal_error";

    const finalized = await this.repository.finalizeAssistantMessage(db, assistantMessageId, {
      content: partialContent,
      status: "error",
      citations,
      retrieval,
      model: null,
    });
    // Same as the success and no-context paths (streamAnswer / finishNoContext)
    // — an errored turn still counts as activity on the conversation, and
    // omitting this meant a conversation that errored never bumped
    // updated_at, so it wouldn't sort correctly in "most recently active"
    // order (found during Phase 5 re-validation; see docs/DECISIONS.md).
    await this.repository.touch(db, conversationId);
    emit({ type: "error", code, message });
    return finalized;
  }
}
