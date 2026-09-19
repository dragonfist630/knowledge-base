"use client";

import { useQuery } from "@tanstack/react-query";
import { UsageSummaryResponseSchema } from "@kb/shared";

import { apiFetch } from "@/lib/api/client";

export const usageKeys = {
  all: ["usage"] as const,
  summary: (days: number) => [...usageKeys.all, "summary", days] as const,
};

/** GET /usage?days=N — token/request usage for the trailing N days, grouped by day/operation/model. No polling: unlike documents/chat, nothing here changes on its own while the page is open. */
export function useUsage(days: number) {
  return useQuery({
    queryKey: usageKeys.summary(days),
    queryFn: () => apiFetch(`/usage?days=${days}`, UsageSummaryResponseSchema),
  });
}
