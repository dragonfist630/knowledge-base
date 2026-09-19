"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { PlusIcon, SearchIcon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { DocumentRow } from "@/features/documents/components/document-row";
import { useDocuments } from "@/features/documents/hooks/use-documents";
import { useLoadSampleDocuments } from "@/features/documents/hooks/use-load-sample-documents";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { ApiError } from "@/lib/api/error";
import { cn } from "@/lib/utils";

export function DocumentList() {
  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | undefined>(undefined);
  const debouncedSearch = useDebouncedValue(search, 300);

  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = useDocuments({
    q: debouncedSearch || undefined,
    tag: activeTag,
  });
  const loadSamples = useLoadSampleDocuments();

  const items = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  const knownTags = useMemo(() => Array.from(new Set(items.flatMap((doc) => doc.tags))).sort(), [items]);
  const isEmpty = !isLoading && items.length === 0 && !debouncedSearch && !activeTag;
  const isFiltered = Boolean(debouncedSearch || activeTag);

  async function handleLoadSamples() {
    try {
      await loadSamples.mutateAsync();
      toast.success("Sample documents added.");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Failed to load sample documents.");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Documents</h1>
        <Button asChild>
          <Link href="/documents/new">
            <PlusIcon className="size-4" />
            New document
          </Link>
        </Button>
      </div>

      <div className="relative">
        <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search documents…"
          className="pl-9"
          aria-label="Search documents"
        />
      </div>

      {knownTags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {knownTags.map((tag) => (
            <Badge
              key={tag}
              variant={activeTag === tag ? "default" : "outline"}
              className={cn("cursor-pointer font-normal", activeTag === tag && "hover:bg-primary/90")}
              onClick={() => setActiveTag((current) => (current === tag ? undefined : tag))}
            >
              {tag}
            </Badge>
          ))}
        </div>
      ) : null}

      {isLoading ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-20 w-full" />
          ))}
        </div>
      ) : isError ? (
        <p className="text-destructive text-sm">Couldn&apos;t load documents. Try refreshing the page.</p>
      ) : items.length === 0 && isFiltered ? (
        <p className="text-muted-foreground text-sm">No documents match your search.</p>
      ) : isEmpty ? (
        <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed p-12 text-center">
          <p className="text-muted-foreground">You don&apos;t have any documents yet.</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild>
              <Link href="/documents/new">
                <PlusIcon className="size-4" />
                Create your first document
              </Link>
            </Button>
            {process.env.NODE_ENV !== "production" ? (
              <Button variant="outline" onClick={() => void handleLoadSamples()} disabled={loadSamples.isPending}>
                <SparklesIcon className="size-4" />
                {loadSamples.isPending ? "Loading…" : "Load sample documents"}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((document) => (
            <DocumentRow key={document.id} document={document} onTagClick={setActiveTag} />
          ))}
          {hasNextPage ? (
            <Button variant="outline" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage} className="self-center">
              {isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
