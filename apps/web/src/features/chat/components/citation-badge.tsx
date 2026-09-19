"use client";

import Link from "next/link";
import type { CitationSnapshot } from "@kb/shared";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Renders one `[S<n>]` marker (see lib/markdown/remark-citations.ts for how
 * the raw marker becomes this component) as a small numbered badge; a
 * click/hover opens a popover with the source document, section, and
 * snippet, plus an "Open document" link to /documents/:id?highlight=start-end
 * (features/documents/components/document-form.tsx reads that query param
 * and selects/scrolls to the range).
 *
 * `citation` is undefined when the source snapshot hasn't arrived yet (the
 * marker can stream in slightly before its citation metadata is fully
 * resolved) — renders a plain, non-interactive number in that case rather
 * than a broken popover.
 */
export function CitationBadge({ sourceId, citation }: { sourceId: string; citation: CitationSnapshot | undefined }) {
  const label = sourceId.replace(/^S/, "");

  if (!citation) {
    return (
      <sup className="mx-0.5 inline-flex size-4 items-center justify-center rounded-full bg-secondary text-[10px] font-medium text-secondary-foreground">
        {label}
      </sup>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Citation ${label}: ${citation.documentTitle}`}
          className="mx-0.5 inline-flex size-4 items-center justify-center rounded-full bg-primary align-super text-[10px] font-medium text-primary-foreground hover:bg-primary/90"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 text-sm">
        <div className="flex flex-col gap-1.5">
          <p className="font-medium">{citation.documentTitle}</p>
          {citation.headingPath ? <p className="text-muted-foreground text-xs">{citation.headingPath}</p> : null}
          <p className="text-muted-foreground line-clamp-4 text-xs italic">&ldquo;{citation.snippet}&rdquo;</p>
          <Link
            href={`/documents/${citation.documentId}?highlight=${citation.charStart}-${citation.charEnd}`}
            className="text-primary text-xs underline underline-offset-4"
          >
            Open document
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
