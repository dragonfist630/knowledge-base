"use client";

import { useEffect, useRef } from "react";
import type { Message as MessageDto } from "@kb/shared";

import { Button } from "@/components/ui/button";
import { Message } from "@/features/chat/components/message";
import type { ChatStreamState } from "@/features/chat/hooks/use-chat-stream";

const NEAR_BOTTOM_PX = 80;

export interface StreamingTurn {
  userText: string;
  assistantState: ChatStreamState;
}

/**
 * Auto-scrolls to the newest message ONLY when the viewer was already at
 * (or near) the bottom before new content arrived — the brief's own
 * wording. A plain native div with a scroll ref (not shadcn's ScrollArea)
 * on purpose: this needs imperative `scrollTop`/`scrollHeight` reads on
 * every content change, which is far simpler against a real scrollable
 * element than Radix ScrollArea's viewport indirection.
 */
export function MessageList({
  history,
  streamingTurn,
  onRetry,
}: {
  history: MessageDto[];
  streamingTurn?: StreamingTurn;
  onRetry?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wasNearBottomRef = useRef(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (wasNearBottomRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  });

  function handleScroll() {
    const container = containerRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    wasNearBottomRef.current = distanceFromBottom <= NEAR_BOTTOM_PX;
  }

  const isEmpty = history.length === 0 && !streamingTurn;

  return (
    <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto" aria-live="polite">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
        {isEmpty ? (
          <p className="text-muted-foreground py-12 text-center text-sm">
            Ask a question about your documents to get started.
          </p>
        ) : null}

        {history.map((message) => (
          <Message
            key={message.id}
            role={message.role}
            content={message.content}
            sources={message.citations}
            citationsById={new Map(message.citations.map((c) => [c.sourceId, c]))}
          />
        ))}

        {streamingTurn ? (
          <>
            <Message role="user" content={streamingTurn.userText} sources={[]} />
            <Message
              role="assistant"
              content={streamingTurn.assistantState.text}
              sources={streamingTurn.assistantState.sources}
              pending={streamingTurn.assistantState.phase === "searching"}
            />
            {streamingTurn.assistantState.phase === "error" ? (
              <div className="flex items-center gap-2">
                <p className="text-destructive text-xs">{streamingTurn.assistantState.errorMessage ?? "Something went wrong."}</p>
                {onRetry ? (
                  <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onRetry}>
                    Retry
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
