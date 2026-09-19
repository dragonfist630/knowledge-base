"use client";

import { useQuery } from "@tanstack/react-query";
import { DocumentDetailSchema } from "@kb/shared";

import { apiFetch } from "@/lib/api/client";
import { documentsKeys } from "@/features/documents/hooks/use-documents";

/**
 * Also polls while the document is still indexing, same rationale as
 * useDocuments — an editor left open on a freshly-created document should
 * see its status badge flip to Ready without a manual refresh.
 */
export function useDocument(id: string) {
  return useQuery({
    queryKey: documentsKeys.detail(id),
    queryFn: () => apiFetch(`/documents/${id}`, DocumentDetailSchema),
    refetchInterval: (query) => {
      const status = query.state.data?.indexStatus;
      return status === "pending" || status === "indexing" ? 2000 : false;
    },
  });
}
