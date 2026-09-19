import { Injectable } from "@nestjs/common";
import type { UsageQuery, UsageSummaryResponse, UsageTotals } from "@kb/shared";

import type { AuthContext } from "../auth/auth-request.js";
// Must stay a value import (constructor-injected) — see docs/DECISIONS.md
// Phase 3, D3.3.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsageRepository } from "./usage.repository.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Sums promptTokens/completionTokens/totalTokens/eventCount across every row — the page's top-line stat tiles. */
export function sumTotals(rows: UsageSummaryResponse["rows"]): UsageTotals {
  return rows.reduce<UsageTotals>(
    (totals, row) => ({
      promptTokens: totals.promptTokens + row.promptTokens,
      completionTokens: totals.completionTokens + row.completionTokens,
      totalTokens: totals.totalTokens + row.totalTokens,
      eventCount: totals.eventCount + row.eventCount,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0, eventCount: 0 },
  );
}

@Injectable()
export class UsageService {
  constructor(private readonly repository: UsageRepository) {}

  async summarize(auth: AuthContext, query: UsageQuery): Promise<UsageSummaryResponse> {
    const from = new Date(Date.now() - query.days * MS_PER_DAY);
    const rows = await this.repository.summarize(auth.db, from);
    return {
      from: from.toISOString(),
      days: query.days,
      totals: sumTotals(rows),
      rows,
    };
  }
}
