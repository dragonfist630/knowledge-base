"use client";

import { useMemo, useState } from "react";
import type { UsageDayRow, UsageOperation } from "@kb/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useUsage } from "@/features/usage/hooks/use-usage";
import { cn } from "@/lib/utils";

const RANGE_OPTIONS = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
] as const;

const numberFormat = new Intl.NumberFormat("en-US");

const OPERATION_LABEL: Record<UsageOperation, string> = {
  chat: "Chat",
  embedding: "Embedding",
  query_rewrite: "Query rewrite",
};

interface ModelTotal {
  model: string;
  operation: UsageOperation;
  totalTokens: number;
  eventCount: number;
}

/** Collapses the (day, operation, model) rows down to one row per (operation, model), for the "by model" breakdown table. */
function groupByModel(rows: UsageDayRow[]): ModelTotal[] {
  const byKey = new Map<string, ModelTotal>();
  for (const row of rows) {
    const key = `${row.operation}::${row.model}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.totalTokens += row.totalTokens;
      existing.eventCount += row.eventCount;
    } else {
      byKey.set(key, { model: row.model, operation: row.operation, totalTokens: row.totalTokens, eventCount: row.eventCount });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => b.totalTokens - a.totalTokens);
}

export function UsageView() {
  const [days, setDays] = useState(30);
  const { data, isLoading, isError } = useUsage(days);

  const byModel = useMemo(() => groupByModel(data?.rows ?? []), [data]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Usage</h1>
        <div className="flex items-center gap-1.5">
          {RANGE_OPTIONS.map((option) => (
            <Button
              key={option.days}
              size="sm"
              variant={days === option.days ? "default" : "outline"}
              onClick={() => setDays(option.days)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-24 w-full" />
          ))}
        </div>
      ) : isError ? (
        <p className="text-destructive text-sm">Couldn&apos;t load usage. Try refreshing the page.</p>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="Total tokens" value={data.totals.totalTokens} />
            <StatTile label="Prompt tokens" value={data.totals.promptTokens} />
            <StatTile label="Completion tokens" value={data.totals.completionTokens} />
            <StatTile label="Requests" value={data.totals.eventCount} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>By model</CardTitle>
              <CardDescription>
                Totals across the last {days} day{days === 1 ? "" : "s"}, most-used first.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {byModel.length === 0 ? (
                <p className="text-muted-foreground text-sm">No AI usage recorded in this window yet.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {byModel.map((entry) => (
                    <div
                      key={`${entry.operation}::${entry.model}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="font-normal">
                          {OPERATION_LABEL[entry.operation]}
                        </Badge>
                        <span className="font-mono text-sm">{entry.model}</span>
                      </div>
                      <div className="text-muted-foreground flex items-center gap-3 text-sm">
                        <span>{numberFormat.format(entry.totalTokens)} tokens</span>
                        <span>
                          {numberFormat.format(entry.eventCount)} request{entry.eventCount === 1 ? "" : "s"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <Card className={cn("gap-1.5 py-4")}>
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent className="px-4">
        <span className="text-2xl font-semibold tabular-nums">{numberFormat.format(value)}</span>
      </CardContent>
    </Card>
  );
}
