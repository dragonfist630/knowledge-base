/**
 * Decides whether the assistant message a live stream is producing has
 * "landed" in persisted history yet — i.e. whether MessageList should stop
 * rendering the live streaming turn and let the persisted history row take
 * over instead.
 *
 * A plain `messages.some(m => m.id === assistantMessageId)` id-only check
 * is wrong: the assistant row is inserted as an empty placeholder
 * (content: "", status: "streaming") the instant a turn starts (see
 * apps/api/src/chat/conversations.repository.ts's insertAssistantPlaceholder),
 * specifically so the id is known before any text exists. Any background
 * refetch of the conversation while a turn is still in flight — a window
 * focus event is the easy, common way to trigger one, since
 * useConversation has no custom staleTime and React Query refetches stale
 * queries on focus by default — pulls that placeholder row into history,
 * matches by id, and makes the live (and, for an in-flight error, the
 * error+retry UI) turn disappear mid-answer, replaced by nothing until the
 * turn eventually finishes and a later refetch brings in the real content.
 *
 * The fix: a message only counts as "landed" once its own status is no
 * longer "streaming" — i.e. the server has actually finalized it
 * (finalizeAssistantMessage sets it to complete/aborted/error; see
 * docs/DECISIONS.md Phase 6, D6.16).
 */
/**
 * @param {{ id: string, status: string }[]} messages
 * @param {string | undefined} assistantMessageId
 * @returns {boolean}
 */
export function isAssistantMessageSettled(messages, assistantMessageId) {
  if (!assistantMessageId) return false;
  return messages.some((message) => message.id === assistantMessageId && message.status !== "streaming");
}
