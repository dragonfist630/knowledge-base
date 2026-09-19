"use client";

import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import {
  DocumentDetailSchema,
  type DocumentCreate,
  type DocumentDetail,
  type DocumentListResponse,
  type DocumentUpdate,
} from "@kb/shared";

import { apiFetch } from "@/lib/api/client";
import { documentsKeys } from "@/features/documents/hooks/use-documents";

type SaveInput = { id?: string; values: DocumentCreate | DocumentUpdate };

/**
 * Handles both create (no `id`) and update (`id` present) through one
 * mutation, since the editor form (features/documents/components/document-form.tsx)
 * is shared between /documents/new and /documents/[id] and shouldn't need
 * to know which verb it's calling.
 *
 * Optimistic: the detail cache (and any matching row across cached list
 * pages) updates immediately with the submitted title/tags/content, and —
 * because saving always re-triggers indexing server-side (see
 * documents.service.ts's create/update, which re-chunks on every write) —
 * `indexStatus` is optimistically flipped to "pending" too, so the status
 * badge doesn't sit on stale "Ready" for the length of one round trip. A
 * failed save rolls both caches back to their pre-mutation snapshot.
 */
export function useSaveDocument() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, values }: SaveInput): Promise<DocumentDetail> => {
      return id
        ? apiFetch(`/documents/${id}`, DocumentDetailSchema, { method: "PATCH", body: values })
        : apiFetch("/documents", DocumentDetailSchema, { method: "POST", body: values });
    },

    onMutate: async ({ id, values }) => {
      // Broad on purpose: cancels in-flight fetches for both the detail
      // query and every list query, so none of them race a stale response
      // in over the optimistic writes below.
      await queryClient.cancelQueries({ queryKey: documentsKeys.all });

      const previousDetail = id ? queryClient.getQueryData<DocumentDetail>(documentsKeys.detail(id)) : undefined;
      // Scoped to `.lists` (not `.all`), which would also match the
      // `detail(id)` entry — that entry isn't `InfiniteData`-shaped
      // (no `.pages`), so the updater below would throw trying to map over
      // it. See documentsKeys.lists's doc comment.
      const previousLists = queryClient.getQueriesData<InfiniteData<DocumentListResponse>>({
        queryKey: documentsKeys.lists,
      });

      if (id && previousDetail) {
        const optimistic: DocumentDetail = {
          ...previousDetail,
          ...values,
          indexStatus: values.content !== undefined ? "pending" : previousDetail.indexStatus,
          updatedAt: new Date().toISOString(),
        };
        queryClient.setQueryData(documentsKeys.detail(id), optimistic);

        queryClient.setQueriesData<InfiniteData<DocumentListResponse>>({ queryKey: documentsKeys.lists }, (data) => {
          if (!data) return data;
          return {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              items: page.items.map((item) => (item.id === id ? { ...item, ...optimistic } : item)),
            })),
          };
        });
      }

      return { previousDetail, previousLists, id };
    },

    onError: (_err, _vars, context) => {
      if (!context) return;
      if (context.id && context.previousDetail) {
        queryClient.setQueryData(documentsKeys.detail(context.id), context.previousDetail);
      }
      for (const [key, data] of context.previousLists) {
        queryClient.setQueryData(key, data);
      }
    },

    onSuccess: (saved) => {
      queryClient.setQueryData(documentsKeys.detail(saved.id), saved);
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: documentsKeys.all });
    },
  });
}
