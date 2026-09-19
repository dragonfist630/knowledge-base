import Link from "next/link";
import type { DocumentSummary } from "@kb/shared";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { IndexStatusBadge } from "@/features/documents/components/index-status-badge";
import { formatRelativeTime } from "@/lib/format";

export function DocumentRow({ document, onTagClick }: { document: DocumentSummary; onTagClick?: (tag: string) => void }) {
  return (
    <Link href={`/documents/${document.id}`} className="block">
      <Card className="flex-row flex-wrap items-center justify-between gap-3 p-4 transition-colors hover:bg-accent/50">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="truncate font-medium">{document.title || "Untitled document"}</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {document.tags.map((tag) => (
              <Badge
                key={tag}
                variant="outline"
                className="font-normal"
                onClick={
                  onTagClick
                    ? (event) => {
                        event.preventDefault();
                        onTagClick(tag);
                      }
                    : undefined
                }
              >
                {tag}
              </Badge>
            ))}
            <span className="text-muted-foreground text-xs">Updated {formatRelativeTime(document.updatedAt)}</span>
          </div>
        </div>
        <IndexStatusBadge status={document.indexStatus} chunkCount={document.chunkCount} />
      </Card>
    </Link>
  );
}
