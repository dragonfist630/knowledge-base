import { describe, expect, it, vi } from "vitest";
import type { UsageDayRow } from "@kb/shared";

// UsageRepository is type-only here — like chat.service.spec.ts /
// retrieval.service.spec.ts, this file constructs UsageService directly
// rather than through Nest's DI container.
import type { UsageRepository } from "./usage.repository.js";
import { sumTotals, UsageService } from "./usage.service.js";

const FAKE_DB = {} as never;
const FAKE_AUTH = { db: FAKE_DB, userId: "u1" } as never;

function row(overrides: Partial<UsageDayRow> = {}): UsageDayRow {
  return {
    day: "2026-09-18",
    operation: "chat",
    model: "mock-chat",
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    eventCount: 1,
    ...overrides,
  };
}

function makeRepository(rows: UsageDayRow[]): UsageRepository {
  return { summarize: vi.fn().mockResolvedValue(rows) } as unknown as UsageRepository;
}

describe("sumTotals", () => {
  it("sums an empty list to all zeros", () => {
    expect(sumTotals([])).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0, eventCount: 0 });
  });

  it("sums across multiple (day, operation, model) buckets", () => {
    const rows = [
      row({ promptTokens: 10, completionTokens: 5, totalTokens: 15, eventCount: 1 }),
      row({ day: "2026-09-17", operation: "embedding", model: "mock-embedding", promptTokens: 20, completionTokens: 0, totalTokens: 20, eventCount: 3 }),
    ];
    expect(sumTotals(rows)).toEqual({ promptTokens: 30, completionTokens: 5, totalTokens: 35, eventCount: 4 });
  });
});

describe("UsageService.summarize", () => {
  it("passes a `from` date `days` days before now to the repository", async () => {
    const repository = makeRepository([]);
    const service = new UsageService(repository);
    const before = Date.now();

    await service.summarize(FAKE_AUTH, { days: 7 });

    const [, fromArg] = vi.mocked(repository.summarize).mock.calls[0]!;
    const deltaMs = before - (fromArg as Date).getTime();
    // Allow a little slack for test execution time, but it must be ~7 days, not ~30 (the schema default) or 0.
    expect(deltaMs).toBeGreaterThan(7 * 24 * 60 * 60 * 1000 - 5000);
    expect(deltaMs).toBeLessThan(7 * 24 * 60 * 60 * 1000 + 5000);
  });

  it("echoes `days` back and totals the returned rows", async () => {
    const rows = [row({ promptTokens: 100, completionTokens: 50, totalTokens: 150, eventCount: 2 })];
    const repository = makeRepository(rows);
    const service = new UsageService(repository);

    const result = await service.summarize(FAKE_AUTH, { days: 14 });

    expect(result.days).toBe(14);
    expect(result.rows).toBe(rows);
    expect(result.totals).toEqual({ promptTokens: 100, completionTokens: 50, totalTokens: 150, eventCount: 2 });
    expect(typeof result.from).toBe("string");
    expect(new Date(result.from).toString()).not.toBe("Invalid Date");
  });

  it("uses the caller's own request-scoped db client, not a shared one", async () => {
    const repository = makeRepository([]);
    const service = new UsageService(repository);

    await service.summarize(FAKE_AUTH, { days: 30 });

    const [dbArg] = vi.mocked(repository.summarize).mock.calls[0]!;
    expect(dbArg).toBe(FAKE_DB);
  });
});
