/**
 * Zod schemas for the chat/conversations feature (Phase 5) — the request
 * body for POST /chat[/stream], and the DTOs GET /conversations[/:id]
 * return. Same "one shared contract" pattern as documents.ts: apps/api
 * validates with these via ZodValidationPipe, apps/web infers its types
 * from the same schemas.
 */

import { z } from "zod";

import { SourceSummarySchema } from "./chat-events.js";

const TAG_MAX = 32;
const CONVERSATION_TITLE_MAX = 200;
const CITATION_SNIPPET_MAX = 300;

// Mirrors documents.ts's own tag normalization (trim, lowercase) — kept as
// a small local duplicate rather than importing from documents.ts, since
// the two features' tag schemas are allowed to diverge later without
// coupling them.
const tag = z.string().trim().min(1, "tags cannot be empty strings").max(TAG_MAX).transform((value) => value.toLowerCase());

export const ChatRequestSchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().min(1, "message is required").max(4000, "message must be 4000 characters or fewer"),
  documentIds: z.array(z.string().uuid()).optional(),
  tags: z.array(tag).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ConversationRenameSchema = z.object({
  title: z.string().trim().min(1, "title is required").max(CONVERSATION_TITLE_MAX),
});
export type ConversationRename = z.infer<typeof ConversationRenameSchema>;

const paginationLimit = z.coerce.number().int().min(1).max(100).default(20);

export const ConversationListQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: paginationLimit,
});
export type ConversationListQuery = z.infer<typeof ConversationListQuerySchema>;

export const MessageRoleSchema = z.enum(["user", "assistant"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

/** Matches public.messages.status in supabase/migrations. */
export const MessageStatusSchema = z.enum(["streaming", "complete", "aborted", "error"]);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

/**
 * One cited source, snapshotted onto the assistant message at the moment
 * it finishes streaming — "cited sources only" per the brief, not every
 * source that was merely retrieved (that fuller list only ever existed
 * transiently in the `sources` SSE event). `snippet` is capped at 300
 * characters (the brief's own number) so a large chunk doesn't bloat every
 * persisted message; `charStart`/`charEnd` are the ORIGINAL document's
 * offsets (unchanged from the chunk's own, from @kb/rag-core's chunker),
 * enough for the UI to deep-link/highlight without re-fetching the chunk.
 */
export const CitationSnapshotSchema = z.object({
  sourceId: z.string(),
  documentId: z.string().uuid(),
  documentTitle: z.string(),
  headingPath: z.string().nullable(),
  snippet: z.string().max(CITATION_SNIPPET_MAX),
  charStart: z.number().int(),
  charEnd: z.number().int(),
  similarity: z.number(),
  score: z.number(),
});
export type CitationSnapshot = z.infer<typeof CitationSnapshotSchema>;

/**
 * Retrieval debug info persisted alongside an assistant message —
 * `rewrittenQuery` is always the query text retrieval actually used
 * (equal to the raw question whenever no rewrite ran or it fell back), so
 * a caller can tell a real rewrite happened by comparing it against the
 * question that was asked (see Gate 5, docs/DECISIONS.md Phase 5).
 */
export const RetrievalDebugSchema = z.object({
  rewrittenQuery: z.string(),
  usedRewrite: z.boolean(),
  sourceCount: z.number().int().nonnegative(),
});
export type RetrievalDebug = z.infer<typeof RetrievalDebugSchema>;

export const MessageSchema = z.object({
  id: z.string().uuid(),
  role: MessageRoleSchema,
  content: z.string(),
  status: MessageStatusSchema,
  citations: z.array(CitationSnapshotSchema),
  retrieval: RetrievalDebugSchema.nullable(),
  model: z.string().nullable(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;

export const ConversationSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ConversationListResponseSchema = z.object({
  items: z.array(ConversationSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ConversationListResponse = z.infer<typeof ConversationListResponseSchema>;

/** GET /conversations/:id — the summary fields plus every message, oldest first. */
export const ConversationDetailSchema = ConversationSummarySchema.extend({
  messages: z.array(MessageSchema),
});
export type ConversationDetail = z.infer<typeof ConversationDetailSchema>;

/** POST /chat's (non-streaming) response — the same turn POST /chat/stream produces, collected into one JSON body instead of an event stream. */
export const ChatResponseSchema = z.object({
  conversationId: z.string().uuid(),
  userMessage: MessageSchema,
  assistantMessage: MessageSchema,
  sources: z.array(SourceSummarySchema),
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;
