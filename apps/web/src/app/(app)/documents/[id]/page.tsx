"use client";

import { use, useMemo } from "react";

import { DocumentForm } from "@/features/documents/components/document-form";
import { useDocument } from "@/features/documents/hooks/use-document";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/error";

/**
 * A client component (not a server-fetched page) so it shares the same
 * TanStack Query cache — and the same live-polling-while-indexing
 * behavior — as the documents list, per the state-management rule in
 * docs/DECISIONS.md Phase 6: server state lives in TanStack Query.
 *
 * Reads `params`/`searchParams` with React's `use()` on the promises Next
 * passes as props (the docs' documented way to read them in a Client
 * Component page) rather than the `useSearchParams()` hook, so this page
 * doesn't need the Suspense-boundary workaround the (auth)/login page
 * does — see docs/DECISIONS.md Phase 6.
 */
export default function DocumentDetailPage({ params, searchParams }: PageProps<"/documents/[id]">) {
  const { id } = use(params);
  const { data: document, isLoading, isError, error } = useDocument(id);
  const resolvedSearchParams = use(searchParams);

  const highlightRange = useMemo((): [number, number] | undefined => {
    const value = resolvedSearchParams.highlight;
    const raw = Array.isArray(value) ? value[0] : value;
    if (!raw) return undefined;
    const [startRaw, endRaw] = raw.split("-");
    const start = Number(startRaw);
    const end = Number(endRaw);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
    return [start, end];
  }, [resolvedSearchParams.highlight]);

  if (isLoading) {
    return (
      <div className="flex max-w-3xl flex-col gap-4">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-1/2" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (isError || !document) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <p className="text-destructive text-sm">
        {notFound ? "That document doesn't exist, or you don't have access to it." : "Couldn't load this document."}
      </p>
    );
  }

  return <DocumentForm documentId={id} document={document} highlightRange={highlightRange} />;
}
