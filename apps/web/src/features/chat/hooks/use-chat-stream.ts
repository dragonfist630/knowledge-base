"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ChatEvent, ChatFinishReason, ChatRequest, SourceSummary, TokenUsage } from "@kb/shared";

import { streamChat } from "@/lib/api/chat-stream";
import { ApiError } from "@/lib/api/error";
import { conversationsKeys } from "@/features/chat/hooks/use-conversations";

export type ChatStreamPhase = "idle" | "searching" | "streaming" | "done" | "error";

export interface ChatStreamState {
  phase: ChatStreamPhase;
  conversationId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  text: string;
  sources: SourceSummary[];
  citedSourceIds: string[];
  finishReason?: ChatFinishReason;
  usage?: TokenUsage;
  errorMessage?: string;
}

const IDLE_STATE: ChatStreamState = { phase: "idle", text: "", sources: [], citedSourceIds: [] };
const SENDING_STATE: ChatStreamState = { ...IDLE_STATE, phase: "searching" };

type Action = { type: "sending" } | { type: "event"; event: ChatEvent } | { type: "aborted" };

/**
 * "Streaming chat state lives in a single useChatStream hook with a
 * reducer over ChatEvents" — the state-management rule in
 * docs/DECISIONS.md Phase 6. Mirrors the SSE contract's own ordering
 * (start -> sources -> (delta|citation)* -> done|error): `phase` is
 * "searching" from the moment `send` is called until the first `delta`
 * arrives (an in-flight request's own `start` SSE event doesn't need to
 * round-trip first — see the "sending" action below and D6.16), which is
 * exactly the window the brief wants a "Searching your documents…"
 * indicator for.
 */
function reducer(state: ChatStreamState, action: Action): ChatStreamState {
  // "sending", not "reset": phase flips to "searching" the instant send()
  // is called, synchronously, before any network round trip. Composer's
  // submit() (and this hook's isStreaming) both gate on phase !== "idle" —
  // if phase only changed once the server's `start` SSE event arrived, a
  // second Enter/click during that round trip (which used to leave phase
  // at "idle" the whole time) would fire a second, fully concurrent
  // /chat/stream request: two streams racing into the same reducer, two
  // user messages posted, the first request's AbortController silently
  // leaked (overwritten in abortRef without ever being aborted). See
  // docs/DECISIONS.md Phase 6, D6.16.
  if (action.type === "sending") return SENDING_STATE;
  if (action.type === "aborted") return { ...state, phase: "done", finishReason: "aborted" };

  const { event } = action;
  switch (event.type) {
    case "start":
      return {
        ...IDLE_STATE,
        phase: "searching",
        conversationId: event.conversationId,
        userMessageId: event.userMessageId,
        assistantMessageId: event.assistantMessageId,
      };
    case "sources":
      return { ...state, sources: event.sources };
    case "delta":
      return { ...state, phase: "streaming", text: state.text + event.text };
    case "citation":
      return state.citedSourceIds.includes(event.sourceId)
        ? state
        : { ...state, citedSourceIds: [...state.citedSourceIds, event.sourceId] };
    case "done":
      return { ...state, phase: "done", finishReason: event.finishReason, usage: event.usage };
    case "error":
      return { ...state, phase: "error", errorMessage: event.message };
    default:
      return state;
  }
}

export interface SendChatInput {
  message: string;
  documentIds?: string[];
  tags?: string[];
}

/**
 * Drives one turn of POST /chat/stream at a time. `conversationId` is
 * whatever the caller currently has (undefined for a brand-new
 * conversation); `onStarted` fires as soon as the `start` event reports
 * the server-assigned conversationId, so the caller can adopt it
 * immediately rather than waiting for the whole answer to finish — see
 * chat-view.tsx's own doc comment for why that adoption must NOT be a
 * real Next.js navigation (it would unmount this hook's instance
 * mid-stream) and instead updates local state plus the URL bar directly.
 */
export function useChatStream(conversationId: string | undefined, onStarted?: (conversationId: string) => void) {
  const [state, dispatch] = useReducer(reducer, IDLE_STATE);
  const abortRef = useRef<AbortController | null>(null);
  const lastInputRef = useRef<SendChatInput | null>(null);
  const queryClient = useQueryClient();

  const send = useCallback(
    async (input: SendChatInput) => {
      // Reentrancy guard, not just a UX nicety: this must not rely on
      // `state.phase` (and therefore a render) having caught up yet.
      // `abortRef.current` is set synchronously below and cleared
      // synchronously in `finally`, so it's true "is a send currently in
      // flight" state, independent of React's render timing. Composer
      // also disables its Send button once `isStreaming` flips, but that
      // update only takes effect on the next render — a fast double
      // Enter/click before that render commits would otherwise start a
      // second, fully concurrent /chat/stream request and leak the first
      // request's AbortController (overwritten below without ever being
      // aborted). See docs/DECISIONS.md Phase 6, D6.16.
      if (abortRef.current) return;

      lastInputRef.current = input;
      dispatch({ type: "sending" });

      const controller = new AbortController();
      abortRef.current = controller;
      const request: ChatRequest = { ...input, conversationId };

      try {
        let settled = false;
        for await (const event of streamChat(request, controller.signal)) {
          if (event.type === "start" && !conversationId) {
            onStarted?.(event.conversationId);
          }
          if (event.type === "done" || event.type === "error") {
            settled = true;
          }
          dispatch({ type: "event", event });
        }
        if (!settled) {
          // apps/api's contract guarantees the stream ends with a `done`
          // or `error` frame — everything after `start` is caught
          // server-side and turned into one or the other (see
          // chat.controller.ts) — so reaching a clean end of the response
          // body without ever seeing either one means the connection was
          // cut from underneath us: a proxy/load balancer idle-closing it,
          // or the server process dying mid-turn. `reader.read()`
          // resolving `{ done: true }` isn't an exception, so the `catch`
          // below never runs for this case either. Without this, the
          // reducer was left wherever it last was (typically
          // "searching"/"streaming") forever: Composer's Send button
          // stayed disabled and MessageList's retry button never appeared
          // (gated on `phase === "error"`), with no indication anything
          // went wrong — the only way out was Stop or a page reload. See
          // docs/DECISIONS.md.
          dispatch({
            type: "event",
            event: { type: "error", code: "stream_ended_unexpectedly", message: "Connection closed unexpectedly. Try again." },
          });
        }
      } catch (error) {
        if (controller.signal.aborted) {
          dispatch({ type: "aborted" });
        } else {
          const message = error instanceof ApiError ? error.message : "Lost connection while streaming the answer.";
          dispatch({ type: "event", event: { type: "error", code: "stream_failed", message } });
        }
      } finally {
        abortRef.current = null;
        void queryClient.invalidateQueries({ queryKey: conversationsKeys.all });
      }
    },
    [conversationId, onStarted, queryClient],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Without this, navigating away mid-stream (clicking "Documents" in the
  // nav, say — a real App Router navigation, unlike the same-conversation
  // history.replaceState adoption this hook's own doc comment explains)
  // unmounts this hook instance but leaves its fetch running to completion
  // in the background: wasted tokens on a request nothing will ever render,
  // and a `finally` that still fires and invalidates conversationsKeys.all
  // for a component no longer on screen. See docs/DECISIONS.md Phase 6,
  // D6.16.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const retry = useCallback(() => {
    if (lastInputRef.current) void send(lastInputRef.current);
  }, [send]);

  return {
    state,
    send,
    stop,
    retry,
    isStreaming: state.phase === "searching" || state.phase === "streaming",
  };
}
