"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiFetchVoid } from "@/lib/api/client";
import { documentsKeys } from "@/features/documents/hooks/use-documents";

export function useDeleteDocument() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => apiFetchVoid(`/documents/${id}`, { method: "DELETE" }),
    onSuccess: (_void, id) => {
      queryClient.removeQueries({ queryKey: documentsKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: documentsKeys.all });
    },
  });
}
