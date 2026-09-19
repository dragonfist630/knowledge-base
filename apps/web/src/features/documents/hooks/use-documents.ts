"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { DocumentListResponseSchema } from "@kb/shared";

import { apiFetch } from "@/lib/api/client";

export interface UseDocumentsParams {
  q?: string;
  tag?: string;
}

export const documentsKeys = {
  all: ["documents"] as const,
  /**
   * The shared partial key for every list query regardless of its
   * `q`/`tag` filter params — for cache operations that need to touch "all
   * currently-cached document lists" without also matching `detail(id)`
   * queries, which live under this same `all` prefix (see D6.x in
   * docs/DECISIONS.md: an operation that assumes `InfiniteData<...>` shape
   * and scopes itself to `documentsKeys.all` instead of `.lists` will also
   * match — and crash on — a `detail(id)` entry, which isn't paginated).
   */
  lists: ["documents", "list"] as const,
  list: (params: UseDocumentsParams) => [...documentsKeys.all, "list", params] as const,
  detail: (id: string) => [...documentsKeys.all, "detail", id] as const,
};

function buildQuery(params: UseDocumentsParams, cursor: string | undefined): string {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.tag) search.set("tag", params.tag);
  if (cursor) search.set("cursor", cursor);
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Cursor-paginated document list, filtered by search text and/or a tag.
 * Polls every 2s, but only while at least one already-loaded document is
 * still `pending`/`indexing` — the brief calls out Supabase Realtime as an
 * optional nicer alternative; polling-only-while-something's-in-flight
 * gets the same "list updates live" UX for a fraction of the complexity,
 * see docs/DECISIONS.md Phase 6.
 */
export function useDocuments(params: UseDocumentsParams) {
  return useInfiniteQuery({
    queryKey: documentsKeys.list(params),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      apiFetch(`/documents${buildQuery(params, pageParam)}`, DocumentListResponseSchema),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: (query) => {
      const pages = query.state.data?.pages ?? [];
      const hasInFlight = pages.some((page) =>
        page.items.some((doc) => doc.indexStatus === "pending" || doc.indexStatus === "indexing"),
      );
      return hasInFlight ? 2000 : false;
    },
  });
}
