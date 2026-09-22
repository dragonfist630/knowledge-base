"use client";

import { useCallback, useState } from "react";

import { Composer, type ComposerSubmitInput } from "@/features/chat/components/composer";
import { ConversationList } from "@/features/chat/components/conversation-list";
import { MessageList } from "@/features/chat/components/message-list";
import type { ChatScope } from "@/features/chat/components/scope-selector";
import { useChatStream } from "@/features/chat/hooks/use-chat-stream";
import { useConversation } from "@/features/chat/hooks/use-conversation";
import { isAssistantMessageSettled } from "@/features/chat/stream-history.mjs";

/**
 * Shared by /chat (no conversation yet) and /chat/[conversationId] — as
 * two separate route files rendering this component, not one component
 * parameterized by a route param, so a real Next.js navigation between
 * them unmounts and remounts it. That matters for the very first turn of
 * a brand-new conversation: the server's `start` SSE event (which reports
 * the newly-created conversationId) arrives before any `delta`, so
 * `router.replace()`-ing from /chat to /chat/[id] the moment it arrives
 * used to remount this component mid-stream, silently discarding the
 * live `useChatStream` instance — the in-flight fetch kept running and
 * dispatching into a reducer nothing was listening to anymore, so the
 * answer never rendered token-by-token; it only appeared once the whole
 * turn finished and a background query refetch pulled in the persisted
 * result. Worse, a stream error arriving after `start` was lost
 * entirely, with nothing in the UI to show it. Fixed by tracking the
 * "adopted" conversation id as local state instead of relying on the
 * route param, and updating the URL with `history.replaceState` (no
 * Next.js navigation, so no remount) rather than `router.replace` — see
 * docs/DECISIONS.md Phase 6, D6.6.
 *
 * A fixed-ish height (rather than filling the viewport exactly) so it
 * doesn't fight the (app) layout's own `<main>` scroll region — see
 * docs/DECISIONS.md Phase 6.
 */
export function ChatView({ conversationId, initialScope }: { conversationId?: string; initialScope?: ChatScope }) {
  const [activeConversationId, setActiveConversationId] = useState(conversationId);
  const { data: conversation } = useConversation(activeConversationId);
  const [pendingUserText, setPendingUserText] = useState<string>();

  const handleStarted = useCallback((newConversationId: string) => {
    setActiveConversationId(newConversationId);
    // Keeps the address bar (and refresh/bookmark/share) correct without
    // triggering an actual App Router navigation — see this component's
    // own doc comment above for why a real navigation here is the bug.
    window.history.replaceState(null, "", `/chat/${newConversationId}`);
  }, []);

  const chatStream = useChatStream(activeConversationId, activeConversationId ? undefined : handleStarted);

  function handleSend(input: ComposerSubmitInput) {
    setPendingUserText(input.message);
    void chatStream.send(input);
  }

  // The streaming turn "retires" into plain history once the conversation
  // refetch (triggered from useChatStream's `finally`) actually contains
  // the FINALIZED assistant message — not just any row with a matching id.
  // The assistant row exists in the DB from the very start of the turn (an
  // empty placeholder, status "streaming" — see
  // conversations.repository.ts's insertAssistantPlaceholder), so a
  // same-id match alone would also match that still-empty placeholder. A
  // background refetch of this conversation while the turn is still in
  // flight — a window focus event is all it takes, since useConversation
  // has no custom staleTime — would then hide the live (and, for an error,
  // the error+retry) turn and show nothing until the turn actually
  // finishes. See docs/DECISIONS.md Phase 6, D6.16.
  const historyHasAssistant = isAssistantMessageSettled(conversation?.messages ?? [], chatStream.state.assistantMessageId);
  const showStreamingTurn = chatStream.state.phase !== "idle" && !historyHasAssistant;

  return (
    <div className="flex h-[75vh] min-h-[420px] overflow-hidden rounded-lg border">
      <ConversationList activeId={activeConversationId} />
      <div className="flex min-w-0 flex-1 flex-col">
        <MessageList
          history={conversation?.messages ?? []}
          streamingTurn={showStreamingTurn ? { userText: pendingUserText ?? "", assistantState: chatStream.state } : undefined}
          onRetry={chatStream.state.phase === "error" ? chatStream.retry : undefined}
        />
        <Composer onSend={handleSend} isStreaming={chatStream.isStreaming} onStop={chatStream.stop} initialScope={initialScope} />
      </div>
    </div>
  );
}
