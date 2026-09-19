"use client";

import { ChevronDownIcon, FileTextIcon } from "lucide-react";
import Link from "next/link";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export interface SourcesPanelItem {
  sourceId: string;
  documentId: string;
  documentTitle: string;
  headingPath: string | null;
}

/** The "Sources" collapsible under each answer — built from whichever's available: the live `sources` SSE event while streaming, or the finished message's own `citations` snapshot once persisted (see message.tsx). */
export function SourcesPanel({ sources }: { sources: SourcesPanelItem[] }) {
  if (sources.length === 0) return null;

  // A source can appear more than once (one per cited chunk) — collapse to
  // one row per document for the summary panel, citation badges inline in
  // the answer still point at the specific chunk.
  const byDocument = new Map<string, SourcesPanelItem>();
  for (const source of sources) {
    if (!byDocument.has(source.documentId)) byDocument.set(source.documentId, source);
  }

  return (
    <Collapsible className="mt-2">
      <CollapsibleTrigger className="text-muted-foreground group flex items-center gap-1 text-xs hover:text-foreground">
        <ChevronDownIcon className="size-3 transition-transform group-data-[state=open]:rotate-180" />
        Sources ({byDocument.size})
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-1.5 flex flex-col gap-1">
          {Array.from(byDocument.values()).map((source) => (
            <li key={source.documentId}>
              <Link
                href={`/documents/${source.documentId}`}
                className={cn(
                  "text-muted-foreground flex items-center gap-1.5 rounded px-1.5 py-1 text-xs hover:bg-accent hover:text-foreground",
                )}
              >
                <FileTextIcon className="size-3 shrink-0" />
                <span className="truncate">{source.documentTitle}</span>
                {source.headingPath ? <span className="truncate opacity-70">· {source.headingPath}</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
