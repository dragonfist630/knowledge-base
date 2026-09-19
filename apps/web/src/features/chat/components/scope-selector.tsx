"use client";

import { useMemo } from "react";
import { ChevronDownIcon, FilterIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { useDocuments } from "@/features/documents/hooks/use-documents";
import { cn } from "@/lib/utils";

export type ChatScope = { mode: "all" } | { mode: "documents"; documentIds: string[] } | { mode: "tags"; tags: string[] };

export const ALL_SCOPE: ChatScope = { mode: "all" };

function scopeLabel(scope: ChatScope): string {
  if (scope.mode === "all") return "All documents";
  if (scope.mode === "documents") return scope.documentIds.length === 1 ? "1 document" : `${scope.documentIds.length} documents`;
  return scope.tags.length === 1 ? `#${scope.tags[0]}` : `${scope.tags.length} tags`;
}

/**
 * "Scope selector in the composer: All documents, selected documents, or
 * tags." A Popover (not a DropdownMenu) because the documents/tags lists
 * are multi-select checklists — a DropdownMenu closes on every item click,
 * which is wrong here.
 */
export function ScopeSelector({ scope, onChange }: { scope: ChatScope; onChange: (scope: ChatScope) => void }) {
  // Only the first page — a full searchable picker is more than this
  // control needs; the composer is meant for quickly scoping to a handful
  // of recently-worked-on documents, not browsing the whole library.
  const { data } = useDocuments({});
  const documents = useMemo(() => data?.pages[0]?.items ?? [], [data]);
  const allTags = useMemo(() => Array.from(new Set(documents.flatMap((doc) => doc.tags))).sort(), [documents]);

  function toggleDocument(id: string) {
    const current = scope.mode === "documents" ? scope.documentIds : [];
    const next = current.includes(id) ? current.filter((docId) => docId !== id) : [...current, id];
    onChange(next.length === 0 ? ALL_SCOPE : { mode: "documents", documentIds: next });
  }

  function toggleTag(tag: string) {
    const current = scope.mode === "tags" ? scope.tags : [];
    const next = current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag];
    onChange(next.length === 0 ? ALL_SCOPE : { mode: "tags", tags: next });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="gap-1.5">
          <FilterIcon className="size-3.5" />
          {scopeLabel(scope)}
          <ChevronDownIcon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="max-h-80 overflow-y-auto p-2">
          <button
            type="button"
            onClick={() => onChange(ALL_SCOPE)}
            className={cn(
              "flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
              scope.mode === "all" && "bg-secondary font-medium",
            )}
          >
            All documents
          </button>

          {documents.length > 0 ? (
            <>
              <Separator className="my-2" />
              <p className="text-muted-foreground px-2 pb-1 text-xs font-medium">Documents</p>
              {documents.map((doc) => {
                const checked = scope.mode === "documents" && scope.documentIds.includes(doc.id);
                return (
                  <button
                    key={doc.id}
                    type="button"
                    onClick={() => toggleDocument(doc.id)}
                    className={cn(
                      "flex w-full items-center gap-2 truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                      checked && "bg-secondary font-medium",
                    )}
                  >
                    <span className="truncate">{doc.title || "Untitled document"}</span>
                  </button>
                );
              })}
            </>
          ) : null}

          {allTags.length > 0 ? (
            <>
              <Separator className="my-2" />
              <p className="text-muted-foreground px-2 pb-1 text-xs font-medium">Tags</p>
              <div className="flex flex-wrap gap-1.5 px-2 pb-1">
                {allTags.map((tag) => {
                  const checked = scope.mode === "tags" && scope.tags.includes(tag);
                  return (
                    <Badge
                      key={tag}
                      variant={checked ? "default" : "outline"}
                      className="cursor-pointer font-normal"
                      onClick={() => toggleTag(tag)}
                    >
                      {tag}
                    </Badge>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
