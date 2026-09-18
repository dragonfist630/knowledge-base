/**
 * The SSE contract for POST /chat/stream (Phase 5) — one zod discriminated
 * union shared verbatim by apps/api (which emits these) and apps/web
 * (which parses `data: <json>\n\n` lines back into this same type). Every
 * event is validated against this schema before being written to the wire,
 * so a bug that would otherwise silently send a malformed event to the
 * browser fails loudly server-side instead.
 */

import { z } from "zod";

/**
 * Mirrors @kb/ai's TokenUsage shape structurally (this package can't import
 * @kb/ai — it must stay browser-safe/server-only-free, and @kb/ai is
 * explicitly server-only). Kept in sync by hand; a mismatch would show up
 * immediately as a type error at the one call site that hands a real
 * TokenUsage to a `done` event (apps/api's chat service).
 */
export const TokenUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimated: z.boolean(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/**
 * The UI-facing view of one retrieved source, sent in the `sources` event
 * BEFORE any answer text so the UI can show "searched N documents"
 * immediately. Deliberately lighter than the full retrieval `Source` (no
 * chunk content/char offsets here — that level of detail is only needed
 * for the cited sources, which travel in the persisted message's
 * `citations` snapshot instead, not duplicated over the wire twice per
 * request). See docs/DECISIONS.md Phase 5.
 */
export const SourceSummarySchema = z.object({
  sourceId: z.string(),
  documentId: z.string().uuid(),
  documentTitle: z.string(),
  headingPath: z.string().nullable(),
  similarity: z.number(),
  score: z.number(),
});
export type SourceSummary = z.infer<typeof SourceSummarySchema>;

/** Matches @kb/ai's FinishReason minus `"other"` — the brief's SSE contract only ever surfaces these three to the browser; apps/api maps a provider's `"other"` to `"stop"` before emitting `done` (see docs/DECISIONS.md Phase 5). */
export const ChatFinishReasonSchema = z.enum(["stop", "length", "aborted"]);
export type ChatFinishReason = z.infer<typeof ChatFinishReasonSchema>;

export const ChatEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    conversationId: z.string().uuid(),
    userMessageId: z.string().uuid(),
    assistantMessageId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("sources"),
    sources: z.array(SourceSummarySchema),
  }),
  z.object({
    type: z.literal("delta"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("citation"),
    sourceId: z.string(),
  }),
  z.object({
    type: z.literal("done"),
    finishReason: ChatFinishReasonSchema,
    usage: TokenUsageSchema,
  }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
]);
export type ChatEvent = z.infer<typeof ChatEventSchema>;
