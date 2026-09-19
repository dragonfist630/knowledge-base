"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DocumentDetailSchema } from "@kb/shared";

import { apiFetch } from "@/lib/api/client";
import { documentsKeys } from "@/features/documents/hooks/use-documents";

/** Powers the "Retry" action on a Failed index-status badge. */
export function useReindexDocument() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => apiFetch(`/documents/${id}/reindex`, DocumentDetailSchema, { method: "POST" }),
    onSuccess: (saved) => {
      queryClient.setQueryData(documentsKeys.detail(saved.id), saved);
      void queryClient.invalidateQueries({ queryKey: documentsKeys.all });
    },
  });
}
