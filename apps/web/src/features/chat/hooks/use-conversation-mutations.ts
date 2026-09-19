"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ConversationSummarySchema } from "@kb/shared";

import { apiFetch, apiFetchVoid } from "@/lib/api/client";
import { conversationsKeys } from "@/features/chat/hooks/use-conversations";

export function useRenameConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      apiFetch(`/conversations/${id}`, ConversationSummarySchema, { method: "PATCH", body: { title } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: conversationsKeys.all });
    },
  });
}

export function useDeleteConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetchVoid(`/conversations/${id}`, { method: "DELETE" }),
    onSuccess: (_void, id) => {
      queryClient.removeQueries({ queryKey: conversationsKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: conversationsKeys.list() });
    },
  });
}
