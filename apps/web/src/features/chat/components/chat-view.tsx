"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Composer, type ComposerSubmitInput } from "@/features/chat/components/composer";
import { ConversationList } from "@/features/chat/components/conversation-list";
import { MessageList } from "@/features/chat/components/message-list";
import type { ChatScope } from "@/features/chat/components/scope-selector";
import { useChatStream } from "@/features/chat/hooks/use-chat-stream";
import { useConversation } from "@/features/chat/hooks/use-conversation";
import { isAssistantMessageSettled } from "@/features/chat/stream-history.mjs";

/**
 * Rendered once by chat/layout.tsx, shared by /chat (no conversation yet)
 * and /chat/[conversationId] — see that layout's own doc comment for why
 * a *layout* rather than one instance per route file. That restructuring
 * (docs/DECISIONS.md D9.10) is what makes it safe for `handleStarted`
 * below to adopt a brand-new conversation's server-assigned id with a
 * real `router.replace()`: the layout stays mounted across that
 * navigation (same as any other /chat <-> /chat/[id] transition now), so
 * there's no remount to avoid and no need for the raw
 * `window.history.replaceState` workaround this component used to use —
 * that workaround changed the visible URL without Next's own router ever
 * finding out, which is exactly what D9.7 found broke a *later*
 * navigation. See D6.6 for the original mid-stream-remount bug this
 * whole area of the code exists to avoid, and D9.7/D9.10 for the
 * workaround's own bug and this fix.
 *
 * A fixed-ish height (rather than filling the viewport exactly) so it
 * doesn't fight the (app) layout's own `<main>` scroll region — see
 * docs/DECISIONS.md Phase 6.
 */
export function ChatView({ conversationId, initialScope }: { conversationId?: string; initialScope?: ChatScope }) {
  const router = useRouter();
  const [activeConversationId, setActiveConversationId] = useState(conversationId);

  // Keep `activeConversationId` in sync when the ROUTE's own
  // `conversationId` prop changes — e.g. the sidebar linking from one
  // existing conversation to another, or (now that chat/layout.tsx keeps
  // this component mounted across every /chat <-> /chat/[id] transition,
  // not just between two existing [id]s) a brand-new conversation
  // adopting its id via `handleStarted` below. Without this, the message
  // list, composer, and any outgoing message would keep silently
  // targeting whichever conversation was active when this instance first
  // mounted, while the sidebar and URL had already moved on. See
  // docs/DECISIONS.md. Adjusting state during render (rather than in a
  // useEffect) per
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  // — the same "resetting state when a prop changes" pattern
  // document-form.tsx already uses for the analogous document-prop-changed
  // case.
  const [lastRouteConversationId, setLastRouteConversationId] = useState(conversationId);
  if (conversationId !== lastRouteConversationId) {
    setLastRouteConversationId(conversationId);
    setActiveConversationId(conversationId);
  }

  const { data: conversation } = useConversation(activeConversationId);
  const [pendingUserText, setPendingUserText] = useState<string>();

  // Set by `handleStarted` immediately before it navigates, so the abort
  // effect below can tell "the conversationId prop is about to change
  // because WE just adopted this id" apart from "the conversationId prop
  // changed because the user navigated away" — see that effect's own
  // comment for why the distinction matters.
  const selfAdoptedIdRef = useRef<string>(undefined);

  const handleStarted = useCallback(
    (newConversationId: string) => {
      setActiveConversationId(newConversationId);
      selfAdoptedIdRef.current = newConversationId;
      // A real Next.js navigation — safe now that chat/layout.tsx (not a
      // per-route page.tsx) renders this component, so this never
      // unmounts it. `scroll: false` since adopting an id mid-conversation
      // shouldn't jump the viewport the way a fresh navigation normally
      // would.
      router.replace(`/chat/${newConversationId}`, { scroll: false });
    },
    [router],
  );

  const chatStream = useChatStream(activeConversationId, activeConversationId ? undefined : handleStarted);

  // Abort any in-flight turn, and reset useChatStream's own state back to
  // idle, the moment the ROUTE's own `conversationId` prop changes to
  // something OTHER than what `handleStarted` itself just adopted (a real
  // navigation the user initiated, away from this turn's conversation) or
  // this component unmounts. `handleStarted` also changes `conversationId`
  // (via its `router.replace`, mid-stream), and that transition must NOT
  // abort or reset the very turn that just started — only a navigation
  // the user didn't initiate as part of this turn should.
  //
  // Both halves matter, for different reasons: `stop()` avoids a stream
  // left running in the background after switching conversations
  // dispatching into this same useChatStream instance's reducer — now
  // visually attached to whichever conversation the user has since
  // switched to, since useChatStream's own unmount-only cleanup (D6.16)
  // never fires for this same-instance navigation (D9.10 made every
  // conversation switch a same-instance navigation, not just this one).
  // `reset()` covers the case `stop()` doesn't: a turn that already
  // FINISHED before the user switched away has nothing left to abort, but
  // useChatStream's state still holds it — without resetting it too, the
  // old conversation's just-finished answer gets rendered as if it were a
  // live turn on top of the new conversation's real history. See
  // docs/DECISIONS.md D6.16, D9.10.
  useEffect(() => {
    return () => {
      if (selfAdoptedIdRef.current !== undefined) {
        selfAdoptedIdRef.current = undefined;
        return;
      }
      chatStream.stop();
      chatStream.reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on conversationId (the prop), not activeConversationId; see comment above.
  }, [conversationId]);

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
