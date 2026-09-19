"use client";

import { useQuery } from "@tanstack/react-query";
import { ConversationDetailSchema } from "@kb/shared";

import { apiFetch } from "@/lib/api/client";
import { conversationsKeys } from "@/features/chat/hooks/use-conversations";

/** Full persisted message history for one conversation — "Chat history persists across sessions (it's loaded from the API)" per the brief. */
export function useConversation(id: string | undefined) {
  return useQuery({
    queryKey: conversationsKeys.detail(id ?? ""),
    queryFn: () => apiFetch(`/conversations/${id}`, ConversationDetailSchema),
    enabled: Boolean(id),
  });
}
