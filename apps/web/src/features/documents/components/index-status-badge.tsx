"use client";

import { CheckIcon, ClockIcon, Loader2Icon, XCircleIcon } from "lucide-react";
import type { IndexStatus } from "@kb/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const CONFIG: Record<IndexStatus, { label: string; icon: typeof ClockIcon; className: string; spin?: boolean }> = {
  pending: { label: "Pending", icon: ClockIcon, className: "text-muted-foreground" },
  indexing: { label: "Indexing", icon: Loader2Icon, className: "text-blue-600 dark:text-blue-400", spin: true },
  ready: { label: "Ready", icon: CheckIcon, className: "text-green-600 dark:text-green-400" },
  failed: { label: "Failed", icon: XCircleIcon, className: "text-destructive" },
};

/**
 * `chunkCount` only renders for `ready` (a pending/indexing/failed doc has
 * no meaningful chunk count yet). `onRetry` is optional — pass it only
 * where a reindex mutation is wired up (the documents list and editor);
 * omitting it just hides the Retry button, e.g. in a read-only context.
 */
export function IndexStatusBadge({
  status,
  chunkCount,
  onRetry,
  retrying,
}: {
  status: IndexStatus;
  chunkCount?: number;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const { label, icon: Icon, className, spin } = CONFIG[status];

  return (
    <div className="flex items-center gap-1.5">
      <Badge variant="outline" className={cn("gap-1 font-normal", className)}>
        <Icon className={cn("size-3", spin && "animate-spin")} />
        {label}
        {status === "ready" && typeof chunkCount === "number" ? ` · ${chunkCount} chunks` : null}
      </Badge>
      {status === "failed" && onRetry ? (
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onRetry} disabled={retrying}>
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      ) : null}
    </div>
  );
}
