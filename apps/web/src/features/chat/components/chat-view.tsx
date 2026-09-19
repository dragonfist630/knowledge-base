"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

import { Composer, type ComposerSubmitInput } from "@/features/chat/components/composer";
import { ConversationList } from "@/features/chat/components/conversation-list";
import { MessageList } from "@/features/chat/components/message-list";
import type { ChatScope } from "@/features/chat/components/scope-selector";
import { useChatStream } from "@/features/chat/hooks/use-chat-stream";
import { useConversation } from "@/features/chat/hooks/use-conversation";

/**
 * Shared by /chat (no conversation yet) and /chat/[conversationId]. A
 * fixed-ish height (rather than filling the viewport exactly) so it
 * doesn't fight the (app) layout's own `<main>` scroll region — see
 * docs/DECISIONS.md Phase 6.
 */
export function ChatView({ conversationId, initialScope }: { conversationId?: string; initialScope?: ChatScope }) {
  const router = useRouter();
  const { data: conversation } = useConversation(conversationId);
  const [pendingUserText, setPendingUserText] = useState<string>();

  const handleStarted = useCallback(
    (newConversationId: string) => {
      router.replace(`/chat/${newConversationId}`);
    },
    [router],
  );

  const chatStream = useChatStream(conversationId, conversationId ? undefined : handleStarted);

  function handleSend(input: ComposerSubmitInput) {
    setPendingUserText(input.message);
    void chatStream.send(input);
  }

  // The streaming turn "retires" into plain history once the conversation
  // refetch (triggered from useChatStream's `finally`) actually contains
  // the finished assistant message — not just on `phase === "done"` — so
  // there's no flash of empty content while that refetch is in flight.
  const historyHasAssistant = chatStream.state.assistantMessageId
    ? (conversation?.messages.some((message) => message.id === chatStream.state.assistantMessageId) ?? false)
    : false;
  const showStreamingTurn = chatStream.state.phase !== "idle" && !historyHasAssistant;

  return (
    <div className="flex h-[75vh] min-h-[420px] overflow-hidden rounded-lg border">
      <ConversationList activeId={conversationId} />
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
