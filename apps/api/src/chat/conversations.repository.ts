import { Injectable } from "@nestjs/common";
import type { CitationSnapshot, ConversationSummary, Message, MessageRole, MessageStatus, RetrievalDebug } from "@kb/shared";
import type { Database, Json } from "@kb/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

type ConversationRow = Database["public"]["Tables"]["conversations"]["Row"];
type MessageRow = Database["public"]["Tables"]["messages"]["Row"];

const CONVERSATION_COLUMNS = "id, title, created_at, updated_at";
const MESSAGE_COLUMNS = "id, role, content, status, citations, retrieval, model, created_at";

export interface ListConversationsParams {
  cursor?: string;
  limit: number;
}

export interface ListConversationsResult {
  items: ConversationSummary[];
  nextCursor: string | null;
}

function toConversationSummary(row: Pick<ConversationRow, "id" | "title" | "created_at" | "updated_at">): ConversationSummary {
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

function toMessage(row: Pick<MessageRow, "id" | "role" | "content" | "status" | "citations" | "retrieval" | "model" | "created_at">): Message {
  return {
    id: row.id,
    role: row.role as MessageRole,
    content: row.content,
    status: row.status as MessageStatus,
    citations: (row.citations as unknown as CitationSnapshot[] | null) ?? [],
    retrieval: row.retrieval as unknown as RetrievalDebug | null,
    model: row.model,
    createdAt: row.created_at,
  };
}

/**
 * Thin wrapper over `conversations` and `messages` — kept as one
 * repository (unlike documents/indexing's separate repositories) because
 * every method here genuinely operates on the pair as one aggregate: a
 * conversation is never meaningfully read, created, or touched without its
 * messages in the same breath, in this feature. No business logic here
 * (that's chat.service.ts); every method takes the caller's request-scoped
 * client, so every query runs under RLS as that user — see
 * supabase/migrations for the conversations_* / messages_* policies (Phase
 * 1), which are what actually stop user B from reading or posting into
 * user A's conversation, not any check in this file.
 */
@Injectable()
export class ConversationsRepository {
  async findById(db: SupabaseClient<Database>, id: string): Promise<ConversationSummary | null> {
    const { data, error } = await db.from("conversations").select(CONVERSATION_COLUMNS).eq("id", id).maybeSingle();
    if (error) throw error;
    return data ? toConversationSummary(data) : null;
  }

  async list(db: SupabaseClient<Database>, params: ListConversationsParams): Promise<ListConversationsResult> {
    let query = db
      .from("conversations")
      .select(CONVERSATION_COLUMNS)
      .order("updated_at", { ascending: false })
      .limit(params.limit + 1);
    if (params.cursor) {
      query = query.lt("updated_at", params.cursor);
    }
    const { data, error } = await query;
    if (error) throw error;

    const rows = data ?? [];
    const hasMore = rows.length > params.limit;
    const page = hasMore ? rows.slice(0, params.limit) : rows;
    const nextCursor = hasMore ? (page.at(-1)?.updated_at ?? null) : null;
    return { items: page.map(toConversationSummary), nextCursor };
  }

  /** `user_id` is deliberately omitted — the column defaults to `auth.uid()`, same pattern as documents.repository.ts's `insert`. Title is trimmed to 60 characters from the first message per the brief; the caller is responsible for that trim. */
  async create(db: SupabaseClient<Database>, title: string): Promise<ConversationSummary> {
    const { data, error } = await db.from("conversations").insert({ title }).select(CONVERSATION_COLUMNS).single();
    if (error) throw error;
    return toConversationSummary(data);
  }

  async rename(db: SupabaseClient<Database>, id: string, title: string): Promise<ConversationSummary | null> {
    const { data, error } = await db
      .from("conversations")
      .update({ title })
      .eq("id", id)
      .select(CONVERSATION_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    return data ? toConversationSummary(data) : null;
  }

  async delete(db: SupabaseClient<Database>, id: string): Promise<boolean> {
    const { data, error } = await db.from("conversations").delete().eq("id", id).select("id").maybeSingle();
    if (error) throw error;
    return data !== null;
  }

  /**
   * Bumps `updated_at` with no other semantic change. `conversations` has
   * an unconditional `set_updated_at` trigger (any update at all bumps it —
   * see supabase/migrations), but this still sends a real value rather than
   * an empty payload, since supabase-js's `.update()` needs at least one
   * column and this keeps the intent explicit either way.
   */
  async touch(db: SupabaseClient<Database>, id: string): Promise<void> {
    const { error } = await db.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", id);
    if (error) throw error;
  }

  /** Oldest-first — both for GET /conversations/:id and for building chat history. */
  async listMessages(db: SupabaseClient<Database>, conversationId: string): Promise<Message[]> {
    const { data, error } = await db
      .from("messages")
      .select(MESSAGE_COLUMNS)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return (data ?? []).map(toMessage);
  }

  async insertUserMessage(db: SupabaseClient<Database>, conversationId: string, content: string): Promise<Message> {
    const { data, error } = await db
      .from("messages")
      .insert({ conversation_id: conversationId, role: "user", content, status: "complete" })
      .select(MESSAGE_COLUMNS)
      .single();
    if (error) throw error;
    return toMessage(data);
  }

  /** The placeholder row emitted in the `start` SSE event — empty content, status='streaming' — updated in place once the turn finishes (see `finalizeAssistantMessage`). */
  async insertAssistantPlaceholder(db: SupabaseClient<Database>, conversationId: string): Promise<Message> {
    const { data, error } = await db
      .from("messages")
      .insert({ conversation_id: conversationId, role: "assistant", content: "", status: "streaming" })
      .select(MESSAGE_COLUMNS)
      .single();
    if (error) throw error;
    return toMessage(data);
  }

  async finalizeAssistantMessage(
    db: SupabaseClient<Database>,
    id: string,
    values: { content: string; status: MessageStatus; citations: CitationSnapshot[]; retrieval: RetrievalDebug | null; model: string | null },
  ): Promise<Message> {
    const { data, error } = await db
      .from("messages")
      .update({
        content: values.content,
        status: values.status,
        citations: values.citations as unknown as Json[],
        retrieval: values.retrieval as unknown as Json,
        model: values.model,
      })
      .eq("id", id)
      .select(MESSAGE_COLUMNS)
      .single();
    if (error) throw error;
    return toMessage(data);
  }
}
