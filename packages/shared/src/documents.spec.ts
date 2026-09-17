import { describe, expect, it } from "vitest";

import { DocumentCreateSchema, DocumentUpdateSchema } from "./documents.js";

describe("DocumentUpdateSchema", () => {
  it("rejects an empty patch (no fields at all)", () => {
    // Regression test: `tags` previously reused the same schema instance
    // as DocumentCreateSchema, which has `.default([])` baked in. Zod
    // (v4) doesn't short-circuit `.optional()` wrapped around a
    // `.default()`-bearing schema on `undefined` input — the default
    // still fires — so an omitted `tags` field silently resolved to `[]`
    // (not `undefined`), which satisfied the `.refine()` below and let a
    // completely empty `{}` PATCH body through as "valid". Caught by
    // apps/api/test/documents.e2e-spec.ts's Gate 3 empty-patch case
    // actually running end to end. See docs/DECISIONS.md Phase 3, D3.4.
    expect(() => DocumentUpdateSchema.parse({})).toThrow(/at least one of/i);
  });

  it("accepts a title-only patch", () => {
    const result = DocumentUpdateSchema.parse({ title: "New title" });
    expect(result).toEqual({ title: "New title" });
  });

  it("accepts an explicit tags-only patch, including clearing all tags", () => {
    const result = DocumentUpdateSchema.parse({ tags: [] });
    expect(result).toEqual({ tags: [] });
  });

  it("normalizes tags: trims, lowercases, dedupes", () => {
    const result = DocumentUpdateSchema.parse({ tags: [" Ops ", "ops", "Runbook"] });
    expect(result.tags?.sort()).toEqual(["ops", "runbook"]);
  });
});

describe("DocumentCreateSchema", () => {
  it("defaults tags to [] when omitted", () => {
    const result = DocumentCreateSchema.parse({ title: "A doc" });
    expect(result.tags).toEqual([]);
    expect(result.content).toBe("");
  });

  it("rejects an empty/whitespace-only title", () => {
    expect(() => DocumentCreateSchema.parse({ title: "   " })).toThrow();
  });

  it("rejects more than 20 tags", () => {
    const tags = Array.from({ length: 21 }, (_, i) => `tag-${i}`);
    expect(() => DocumentCreateSchema.parse({ title: "A doc", tags })).toThrow();
  });
});
