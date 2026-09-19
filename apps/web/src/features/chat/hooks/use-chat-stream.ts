"use client";

import { useCallback, useReducer, useRef } from "react";
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

type Action = { type: "reset" } | { type: "event"; event: ChatEvent } | { type: "aborted" };

/**
 * "Streaming chat state lives in a single useChatStream hook with a
 * reducer over ChatEvents" — the state-management rule in
 * docs/DECISIONS.md Phase 6. Mirrors the SSE contract's own ordering
 * (start -> sources -> (delta|citation)* -> done|error): `phase` is
 * "searching" from `start` until the first `delta` arrives, which is
 * exactly the window the brief wants a "Searching your documents…"
 * indicator for.
 */
function reducer(state: ChatStreamState, action: Action): ChatStreamState {
  if (action.type === "reset") return IDLE_STATE;
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
      lastInputRef.current = input;
      dispatch({ type: "reset" });

      const controller = new AbortController();
      abortRef.current = controller;
      const request: ChatRequest = { ...input, conversationId };

      try {
        for await (const event of streamChat(request, controller.signal)) {
          if (event.type === "start" && !conversationId) {
            onStarted?.(event.conversationId);
          }
          dispatch({ type: "event", event });
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
