"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { ConversationListResponseSchema } from "@kb/shared";

import { apiFetch } from "@/lib/api/client";

export const conversationsKeys = {
  all: ["conversations"] as const,
  list: () => [...conversationsKeys.all, "list"] as const,
  detail: (id: string) => [...conversationsKeys.all, "detail", id] as const,
};

/** The chat sidebar's conversation list, newest-updated first (apps/api orders by updated_at desc). */
export function useConversations() {
  return useInfiniteQuery({
    queryKey: conversationsKeys.list(),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      apiFetch(`/conversations${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`, ConversationListResponseSchema),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}
